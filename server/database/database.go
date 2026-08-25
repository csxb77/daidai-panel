package database

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"daidai-panel/config"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var DB *gorm.DB

func Init(cfg *config.DatabaseConfig) {
	dbPath := cfg.Path
	if dbPath == "" {
		dbPath = "./data/daidai.db"
	}

	dir := filepath.Dir(dbPath)
	os.MkdirAll(dir, 0755)

	customLogger := logger.New(
		log.New(os.Stdout, "\r\n", log.LstdFlags),
		logger.Config{
			SlowThreshold:             200000000,
			LogLevel:                  logger.Warn,
			IgnoreRecordNotFoundError: true,
			Colorful:                  false,
		},
	)

	var err error
	DB, err = gorm.Open(sqlite.Open(dbPath), &gorm.Config{
		Logger: customLogger,
	})
	if err != nil {
		log.Fatalf("failed to connect database: %v", err)
	}

	sqlDB, err := DB.DB()
	if err != nil {
		log.Fatalf("failed to get sql.DB: %v", err)
	}

	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)

	DB.Exec("PRAGMA journal_mode=WAL")
	DB.Exec("PRAGMA busy_timeout=5000")
	DB.Exec("PRAGMA foreign_keys=ON")

	log.Printf("database connected: %s", dbPath)
}

func AutoMigrate(models ...interface{}) {
	if err := DB.AutoMigrate(models...); err != nil {
		log.Fatalf("auto migrate failed: %v", err)
	}
}

type columnDef struct {
	Name    string
	SQLType string
}

func getExistingColumns(table string) map[string]bool {
	cols := make(map[string]bool)
	type pragmaRow struct {
		Name string
	}
	var rows []pragmaRow
	DB.Raw(fmt.Sprintf("PRAGMA table_info(%s)", table)).Scan(&rows)
	for _, r := range rows {
		cols[strings.ToLower(r.Name)] = true
	}
	return cols
}

func ensureTableColumns(table string, columns []columnDef) {
	existing := getExistingColumns(table)
	if len(existing) == 0 {
		return
	}
	for _, col := range columns {
		lookupName := strings.ToLower(strings.Trim(col.Name, "\""))
		if !existing[lookupName] {
			sql := fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", table, col.Name, col.SQLType)
			if err := DB.Exec(sql).Error; err != nil {
				log.Printf("warn: failed to add column %s.%s: %v", table, col.Name, err)
			} else {
				log.Printf("added missing column: %s.%s", table, col.Name)
			}
		}
	}
}

func EnsureColumns() {
	ensureTableColumns("tasks", []columnDef{
		{"pid", "INTEGER"},
		{"log_path", "VARCHAR(256)"},
		{"last_running_time", "REAL"},
		{"task_before", "TEXT"},
		{"task_after", "TEXT"},
		{"task_type", "VARCHAR(16) DEFAULT 'cron'"},
		{"last_startup_auto_run_date", "VARCHAR(10) DEFAULT ''"},
		{"allow_multiple_instances", "BOOLEAN DEFAULT 0"},
		{"timeout", "INTEGER DEFAULT 0"},
		{"success_exit_codes", "VARCHAR(128) NOT NULL DEFAULT '0'"},
		{"random_delay_seconds", "INTEGER"},
		{"max_retries", "INTEGER DEFAULT 0"},
		{"retry_interval", "INTEGER DEFAULT 60"},
		{"notify_on_failure", "BOOLEAN DEFAULT 0"},
		{"notify_on_success", "BOOLEAN DEFAULT 0"},
		{"notify_on_abort", "BOOLEAN DEFAULT 0"},
		{"notification_channel_id", "INTEGER"},
		{"depends_on", "INTEGER"},
		{"sort_order", "INTEGER DEFAULT 0"},
		{"is_pinned", "BOOLEAN DEFAULT 0"},
		{"python_version", "VARCHAR(16) DEFAULT ''"},
		// DEFAULT 0：存量任务升级后一律未加锁，首次拉取行为与升级前完全一致。
		{"subscription_locked", "BOOLEAN DEFAULT 0"},
	})
	migrateLegacyTaskPIDColumn()
	unlockNonSubscriptionTasks()

	ensureTableColumns("task_logs", []columnDef{
		{"log_path", "VARCHAR(256)"},
		{"duration", "REAL"},
		{"started_at", "DATETIME"},
		{"ended_at", "DATETIME"},
	})

	ensureTableColumns("env_vars", []columnDef{
		{"position", "REAL DEFAULT 10000.0"},
		{"sort_order", "INTEGER DEFAULT 0"},
		{"\"group\"", "VARCHAR(512) DEFAULT ''"},
	})

	ensureTableColumns("subscriptions", []columnDef{
		{"save_dir", "VARCHAR(512) DEFAULT ''"},
		{"ssh_key_id", "INTEGER"},
		{"auth_type", "VARCHAR(16) DEFAULT ''"},
		{"auth_token", "TEXT DEFAULT ''"},
		{"alias", "VARCHAR(128) DEFAULT ''"},
		{"auto_add_task", "BOOLEAN DEFAULT 0"},
		{"auto_del_task", "BOOLEAN DEFAULT 0"},
		{"whitelist", "VARCHAR(512) DEFAULT ''"},
		{"blacklist", "VARCHAR(512) DEFAULT ''"},
		{"depend_on", "VARCHAR(512) DEFAULT ''"},
		{"hook_script", "TEXT DEFAULT ''"},
		// 拉取前指令。DEFAULT ''：存量订阅升级后一律为空，拉取链路与升级前完全一致。
		{"pre_script", "TEXT DEFAULT ''"},
		// force_overwrite 是 v2.0.2 就有的老列，之前一直靠 AutoMigrate 兜底、没在这里登记，
		// 与本文件「所有历史列都显式补一遍」的约定不一致，顺手补上。它现在只做只读兼容。
		{"force_overwrite", "BOOLEAN DEFAULT 1"},
		// inherit：存量订阅升级后一律跟随全局开关，拉取行为与升级前完全一致（同 notify_channels.push_scope 的写法）。
		// 这里刻意新增一列而不是把 force_overwrite 改成 nullable —— 存量行的 force_overwrite 全是 1，
		// 复用它会让所有老订阅被解读成「强制覆盖」，把全局关掉的用户升级后静默切回覆盖模式。
		{"overwrite_mode", "VARCHAR(16) NOT NULL DEFAULT 'inherit'"},
	})

	ensureTableColumns("notify_channels", []columnDef{
		{"today_send_count", "INTEGER DEFAULT 0"},
		{"today_send_date", "VARCHAR(10) DEFAULT ''"},
		{"last_test_at", "DATETIME"},
		{"last_test_status", "VARCHAR(16) DEFAULT ''"},
		// push_scope：default = 参与广播，bound = 只有被显式绑定时才推送。
		// 带 NOT NULL DEFAULT 是为了让老库 ALTER TABLE 补列时，存量行直接落成 'default'，
		// 升级后的行为与升级前完全一致（同表 success_exit_codes 也是这个写法）。
		{"push_scope", "VARCHAR(16) NOT NULL DEFAULT 'default'"},
	})

	ensureTableColumns("open_apps", []columnDef{
		{"rate_limit", "INTEGER DEFAULT 0"},
		{"call_count", "INTEGER DEFAULT 0"},
	})

	ensureTableColumns("api_call_logs", []columnDef{
		{"app_name", "VARCHAR(128)"},
		{"duration", "REAL DEFAULT 0"},
	})

	ensureTableColumns("login_logs", []columnDef{
		{"method", "VARCHAR(32) DEFAULT '密码登录'"},
		{"client_name", "VARCHAR(255) DEFAULT ''"},
	})

	ensureTableColumns("user_sessions", []columnDef{
		{"refresh_jti", "VARCHAR(36)"},
		{"refresh_expires_at", "DATETIME"},
		{"client_type", "VARCHAR(16) DEFAULT 'web'"},
		{"client_name", "VARCHAR(255) DEFAULT ''"},
	})

	ensureTableColumns("task_views", []columnDef{
		{"hidden", "BOOLEAN DEFAULT 0"},
		{"sort_order", "INTEGER DEFAULT 0"},
	})

	ensureTableColumns("dependencies", []columnDef{
		{"python_version", "VARCHAR(16) DEFAULT ''"},
	})

	ensureTableColumns("users", []columnDef{
		{"avatar_url", "VARCHAR(512) DEFAULT ''"},
	})

	dropEnvVarUniqueIndex()

	log.Printf("column check completed")
}

// migrateLegacyTaskPIDColumn copies values from the old GORM-derived p_id column
// into pid. The Task.PID field is now explicitly mapped to pid, but older local
// SQLite databases may still contain p_id from previous AutoMigrate runs.
func migrateLegacyTaskPIDColumn() {
	existing := getExistingColumns("tasks")
	if !existing["p_id"] || !existing["pid"] {
		return
	}
	if err := DB.Exec("UPDATE tasks SET pid = p_id WHERE pid IS NULL AND p_id IS NOT NULL").Error; err != nil {
		log.Printf("warn: failed to migrate legacy tasks.p_id values to tasks.pid: %v", err)
	}
}

// unlockNonSubscriptionTasks 清理存量误加的订阅锁：早期版本的写入点没判断任务归属，
// 任何任务改名或改定时都会被加锁，手动建的任务也会显示「已锁定」。
//
// 只解锁「labels 里没有 subscription: 标签」的任务是安全的：没有任何订阅同步会去读非订阅任务的锁，
// 解锁不改变调度行为，只是让界面不再显示误导标签。反过来，真正的订阅任务一行都不能碰——
// 它们的锁记录的是用户手改名称/定时的意图，清掉会让下一次订阅拉取把用户的改动覆盖回去。
//
// 判定必须卡住标签边界，不能写成裸子串匹配 labels LIKE '%subscription:%'：
// 用户自建标签 "my-subscription:foo" 会被那种写法当成订阅归属而跳过清理，锁就永远留在库里。
// 而列表页的「已锁定」只看 subscription_locked，详情页的「订阅同步」整行却按标签边界判定归属，
// 于是这个任务显示着锁、却没有「恢复为订阅默认」的入口；加锁逻辑同样判它不是订阅任务、以后也不会再碰，
// 用户永远解不开——这不是显示瑕疵，是不可自愈的死状态，所以必须收口。
//
// labels 是逗号分隔的字符串（model.Task.Labels 用 strings.Join 存），订阅标签只可能出现在整串开头
// 或某个逗号之后；给整串前面补一个逗号，两种位置就统一成 ",subscription:" 一种形态，一次 LIKE 就够，
// 不必把那串 replace 抄两遍。匹配前先抹掉所有空白（空格/Tab/CR/LF，都是单字节 ASCII，不会破坏 UTF-8 汉字）
// 是为了对齐 Go 侧 hasSubscriptionLabel 的 TrimSpace：历史脏数据里的 " subscription:1"、
// "我的标签, subscription:1" 在后端算订阅任务、照样会被加锁，SQL 侧若不覆盖就会把真订阅任务的锁解掉，
// 让用户手改的名称/定时在下次拉取时被覆盖回去。
//
// 方向是「宁可漏解锁（少清一个误锁而已），不可误解锁」，所以 SQL 认定的订阅任务只能比 Go 侧更宽、不能更窄：
// 抹空白只会让更多行被当成订阅任务而跳过；SQLite 的 LIKE 默认对 ASCII 大小写不敏感，手改出来的
// "SUBSCRIPTION:1" 也会被跳过（真订阅标签由 service 侧 fmt.Sprintf 生成、恒为小写，不受影响）。
// 两者都落在保守的那一侧，所以不额外处理大小写。
//
// 幂等：每次启动都会跑，但第一次跑完这些行的 subscription_locked 已是 0，之后再也匹配不到，
// 所以不需要额外的迁移标记表。
func unlockNonSubscriptionTasks() {
	existing := getExistingColumns("tasks")
	if !existing["subscription_locked"] || !existing["labels"] {
		return
	}
	result := DB.Exec(`UPDATE tasks SET subscription_locked = 0
		WHERE subscription_locked = 1
		  AND (
		    labels IS NULL OR labels = ''
		    OR (',' || replace(replace(replace(replace(labels, ' ', ''), char(9), ''), char(10), ''), char(13), '')) NOT LIKE '%,subscription:%'
		  )`)
	if result.Error != nil {
		log.Printf("warn: failed to unlock non-subscription tasks: %v", result.Error)
		return
	}
	if result.RowsAffected > 0 {
		log.Printf("unlocked %d non-subscription tasks that were mistakenly subscription_locked", result.RowsAffected)
	}
}

// dropEnvVarUniqueIndex 迁移：青龙化后 (name, remarks) 不再是业务唯一键，
// 旧部署里如果残留了 idx_env_vars_name_remarks 唯一索引，需要清理掉，
// 否则写入端放开后 DB 层仍会拒绝同 (name, remarks) 的新增。幂等操作。
func dropEnvVarUniqueIndex() {
	if DB == nil {
		return
	}
	if _, err := DB.DB(); err != nil {
		return
	}
	var count int64
	if err := DB.Raw("SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_env_vars_name_remarks'").Scan(&count).Error; err != nil {
		return
	}
	if count == 0 {
		return
	}
	if err := DB.Exec(`DROP INDEX IF EXISTS idx_env_vars_name_remarks`).Error; err != nil {
		log.Printf("warn: failed to drop legacy unique index idx_env_vars_name_remarks: %v", err)
		return
	}
	log.Printf("dropped legacy unique index env_vars(name, remarks) to allow qinglong-style multi-account inserts")
}
