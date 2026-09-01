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

// UniqueNameTarget 描述一张「本轮要加名称唯一索引」的表。
// ScopeColumn 为空表示整张表按 name 唯一；非空表示唯一键是「ScopeColumn + name」的复合键。
type UniqueNameTarget struct {
	Table       string
	ScopeColumn string
	Label       string
}

// UniqueNameTargets 必须与 model 里带 uniqueIndex 的名称列一一对应。
// 加/删 model 上的名称唯一索引时，这张表要同步改，漏改的表现是升级时直接起不来。
//
// 之所以导出：测试要表驱动遍历它，逐张表实测「造重名 -> 去重 -> 索引能建出来」。
// 如果测试自己抄一份表名清单，最致命的失败模式反而测不出来 ——
// 这里的表名一旦写错（或将来 model 改了 TableName），去重会静默跳过那张表，
// 老库升级时 AutoMigrate 建索引失败直接 log.Fatalf、面板起不来，而 go test 全绿。
var UniqueNameTargets = []UniqueNameTarget{
	{Table: "notify_channels", Label: "通知渠道"},
	{Table: "ssh_keys", Label: "SSH 密钥"},
	{Table: "task_views", Label: "任务视图"},
	{Table: "open_apps", Label: "OpenAPI 应用"},
	// 令牌唯一键是「平台 + 名称」，不同平台下的同名令牌是正常用法，不能按裸 name 去重。
	{Table: "platform_tokens", ScopeColumn: "platform_id", Label: "平台令牌"},
}

// NextAvailableName 在 used（已被占用的名字集合）里给 base 找一个不冲突的名字：
// base 本身没被占用就原样返回，否则依次尝试 "base (2)"、"base (3)"…；
// 实在找不到（同一个名字重复上万次的脏数据）返回空串，由调用方决定怎么兜底。
// used 为 nil 等价于「什么都没被占用」，调用方不需要额外判空。
//
// 单独抽出来是因为「名称唯一」这条约束有两条互不相干的入口：
//  1. 启动迁移 DeduplicateBeforeUniqueIndex()，洗的是活库里的历史重名；
//  2. 恢复备份 service.restoreBackupManifest()，写回的是老版本导出的归档 —— 归档内容不会随升级改变，
//     v3.0.10 时代导出的备份里那两条都叫「推送」的通知渠道会一直是重名的。
//
// 两边必须用同一套改名规则，用户才不会在「升级后」和「恢复老备份后」看到两套不同的名字。
func NextAvailableName(used map[string]bool, base string) string {
	if !used[base] {
		return base
	}
	// 上限只是防御性兜底，正常几轮就能命中；没有它的话脏数据能把启动流程卡成死循环。
	for suffix := 2; suffix < 10000; suffix++ {
		candidate := fmt.Sprintf("%s (%d)", base, suffix)
		if !used[candidate] {
			return candidate
		}
	}
	return ""
}

// DeduplicateBeforeUniqueIndex 必须在 AutoMigrate 之前调用。
//
// 为什么非得抢在前面：database.AutoMigrate 出错是 log.Fatalf，
// 新加的 uniqueIndex 一旦撞上历史库里的同名数据，AutoMigrate 建索引就会失败，
// 用户看到的是「升级完面板起不来」，而且没有任何自救入口。
// 现成的 service.MergeDuplicatePythonDependencies 跑在 AutoMigrate 之后，位置不能照抄。
//
// 处理方式是**改名不是删除**：同一唯一键下按 id 升序保留第一条，其余追加 " (2)" / " (3)" 后缀。
// 删用户数据不可接受 —— 重复的通知渠道里也可能存着用户唯一一份 webhook 地址。
// 改名前会检查新名字本身是否已被占用（老库里可能真有一条叫「渠道 (2)」的），占用就继续往后递增。
//
// 幂等：库里没有重复时整个函数什么都不做，所以重复启动不会反复改名。
// 表不存在（全新库，此时 AutoMigrate 还没建表）或缺列（更老的库）都直接跳过，不报错。
func DeduplicateBeforeUniqueIndex() {
	if DB == nil {
		return
	}
	if _, err := DB.DB(); err != nil {
		return
	}

	for _, target := range UniqueNameTargets {
		columns := getExistingColumns(target.Table)
		// 全新库这里拿到的是空 map（PRAGMA table_info 查不存在的表不报错、只是没有行），直接跳过。
		if len(columns) == 0 || !columns["id"] || !columns["name"] {
			continue
		}
		if target.ScopeColumn != "" && !columns[strings.ToLower(target.ScopeColumn)] {
			continue
		}

		// 无隔离列的表统一用常量 0 当作 scope，后面的分组逻辑就只有一套。
		scopeExpr := "0"
		if target.ScopeColumn != "" {
			scopeExpr = fmt.Sprintf("COALESCE(%s, 0)", target.ScopeColumn)
		}

		type uniqueNameRow struct {
			ID    uint
			Name  string
			Scope int64
		}
		var rows []uniqueNameRow
		querySQL := fmt.Sprintf("SELECT id AS id, COALESCE(name, '') AS name, %s AS scope FROM %s ORDER BY id ASC", scopeExpr, target.Table)
		if err := DB.Raw(querySQL).Scan(&rows).Error; err != nil {
			log.Printf("warn: 读取 %s 的名称用于唯一约束去重失败: %v", target.Table, err)
			continue
		}
		if len(rows) < 2 {
			continue
		}

		// usedByScope 按 scope 分桶收全部现存名字，用来判断候选新名字是否也被占用
		// （老库里可能真有一条叫「渠道 (2)」的，直接拼 (2) 会二次撞车）；
		// 分桶而不是拼一个大 key，是为了能把每个桶原样交给 NextAvailableName。
		// seen 记录每个唯一键第一次出现的位置，之后再出现的才算重复。
		usedByScope := make(map[int64]map[string]bool)
		seen := make(map[string]bool, len(rows))
		for _, row := range rows {
			if usedByScope[row.Scope] == nil {
				usedByScope[row.Scope] = make(map[string]bool)
			}
			usedByScope[row.Scope][row.Name] = true
		}

		renamed := 0
		for _, row := range rows {
			key := fmt.Sprintf("%d\x00%s", row.Scope, row.Name)
			if !seen[key] {
				seen[key] = true
				continue
			}

			// 走到这里说明这条是重复项，row.Name 必定已经在 usedByScope 里，
			// 所以 NextAvailableName 一定从 " (2)" 开始找，不会把原名原样还回来。
			newName := NextAvailableName(usedByScope[row.Scope], row.Name)
			if newName == "" || newName == row.Name {
				log.Printf("warn: %s「%s」重名过多，未能自动改名，唯一索引可能建不出来", target.Label, row.Name)
				continue
			}

			updateSQL := fmt.Sprintf("UPDATE %s SET name = ? WHERE id = ?", target.Table)
			if err := DB.Exec(updateSQL, newName, row.ID).Error; err != nil {
				log.Printf("warn: 重命名重复的%s（id=%d）失败: %v", target.Label, row.ID, err)
				continue
			}
			usedByScope[row.Scope][newName] = true
			seen[fmt.Sprintf("%d\x00%s", row.Scope, newName)] = true
			renamed++
			// 逐条写日志：用户升级后打开面板发现「我的渠道名怎么变了」，得能在面板日志里找到答案。
			log.Printf("唯一约束迁移：检测到重名的%s，已把 id=%d 的「%s」改名为「%s」", target.Label, row.ID, row.Name, newName)
		}

		if renamed > 0 {
			log.Printf("唯一约束迁移：%s 共重命名 %d 条重名记录", target.Label, renamed)
		}
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
		// 完整检出开关。NOT NULL DEFAULT 0：老库 ALTER TABLE 补列时存量行一律落成 0，
		// 也就是「继续走 sparse-checkout」——升级后拉取行为与升级前完全一致，
		// 不需要任何数据回填。带 NOT NULL 是为了不让 NULL 漏进来（同表 overwrite_mode 的写法）。
		{"full_checkout", "BOOLEAN NOT NULL DEFAULT 0"},
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
