package cron

import (
	"fmt"
	"sort"
	"strings"
	"time"

	robfigcron "github.com/robfig/cron/v3"
)

type ParseResult struct {
	Valid       bool
	HasSecond   bool
	Fields      map[string]string
	Description string
	Error       string
}

func SplitExpressions(raw string) []string {
	lines := strings.FieldsFunc(raw, func(r rune) bool {
		return r == '\n' || r == '\r'
	})
	result := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line != "" {
			result = append(result, line)
		}
	}
	return result
}

func NormalizeExpressions(raw string) string {
	return strings.Join(SplitExpressions(raw), "\n")
}

func ValidateExpressions(raw string) error {
	expressions := SplitExpressions(raw)
	if len(expressions) == 0 {
		return fmt.Errorf("请至少填写一条定时规则")
	}

	for index, expression := range expressions {
		result := Parse(expression)
		if !result.Valid {
			return fmt.Errorf("第 %d 条定时规则无效: %s", index+1, result.Error)
		}
	}
	return nil
}

func Parse(expression string) ParseResult {
	expression = strings.TrimSpace(expression)
	parts := strings.Fields(expression)

	parser, hasSecond, err := parserForParts(parts)
	if err != nil {
		return ParseResult{Valid: false, Error: err.Error()}
	}

	if _, err := parser.Parse(expression); err != nil {
		return ParseResult{Valid: false, Error: err.Error()}
	}

	fields := buildFields(parts, hasSecond)
	return ParseResult{
		Valid:       true,
		HasSecond:   hasSecond,
		Fields:      fields,
		Description: describe(fields, hasSecond),
	}
}

func NextRunTimes(expression string, count int) []time.Time {
	return NextRunTimesFrom(expression, count, time.Now())
}

func NextRunTimesFrom(expression string, count int, from time.Time) []time.Time {
	if count <= 0 {
		return nil
	}

	schedule, err := ParseSchedule(expression)
	if err != nil {
		return nil
	}

	times := make([]time.Time, 0, count)
	next := from
	for i := 0; i < count; i++ {
		next = schedule.Next(next)
		if next.IsZero() {
			break
		}
		times = append(times, next)
	}
	return times
}

func NextRunTimesForExpressions(raw string, count int) []time.Time {
	return NextRunTimesForExpressionsFrom(raw, count, time.Now())
}

func NextRunTimesForExpressionsFrom(raw string, count int, from time.Time) []time.Time {
	if count <= 0 {
		return nil
	}

	expressions := SplitExpressions(raw)
	if len(expressions) == 0 {
		return nil
	}

	times := make([]time.Time, 0, len(expressions)*count)
	for _, expression := range expressions {
		times = append(times, NextRunTimesFrom(expression, count, from)...)
	}

	sort.Slice(times, func(i, j int) bool {
		return times[i].Before(times[j])
	})

	if len(times) > count {
		times = times[:count]
	}
	return times
}

func parserForParts(parts []string) (robfigcron.Parser, bool, error) {
	switch len(parts) {
	case 5:
		return robfigcron.NewParser(
			robfigcron.Minute |
				robfigcron.Hour |
				robfigcron.Dom |
				robfigcron.Month |
				robfigcron.Dow |
				robfigcron.Descriptor,
		), false, nil
	case 6:
		return robfigcron.NewParser(
			robfigcron.Second |
				robfigcron.Minute |
				robfigcron.Hour |
				robfigcron.Dom |
				robfigcron.Month |
				robfigcron.Dow |
				robfigcron.Descriptor,
		), true, nil
	default:
		return robfigcron.Parser{}, false, errInvalidFieldCount
	}
}

func parseSchedule(expression string) (robfigcron.Schedule, error) {
	return ParseSchedule(expression)
}

func ParseSchedule(expression string) (robfigcron.Schedule, error) {
	expression = strings.TrimSpace(expression)
	parts := strings.Fields(expression)
	parser, _, err := parserForParts(parts)
	if err != nil {
		return nil, err
	}
	return parser.Parse(expression)
}

// errInvalidFieldCount 是段数不合法时唯一的报错出口，文案直接会显示在面板上，所以说人话并交代两件事：
//  1. 6 段和 5 段各自的段位含义。两者都合法，但少写/多写一段会让每一段的含义整体平移
//     （6 段的 `0 5 * * * *` 是每小时第 5 分钟，5 段的 `0 5 * * *` 却是每天 05:00），
//     不写清楚的话用户只会得到一句「必须是 5 段或 6 段」，仍然不知道自己错在哪；
//  2. @daily / @hourly / @every 1h / TZ= 前缀这类简写【不支持】。parserForParts 先按 strings.Fields 的
//     段数分派，这些写法（1 段、2 段、7 段）根本进不到解析器，而用户很可能会照着别处的教程去试。
//
// 刻意不在这里举「0 0 5 * * * = 每天 05:00:00」这类例子：这条文案会整块渲染成红色错误徽标，
// 徽标可用宽只有 500px 左右，句子越长红块越厚（原来的版本要压 4~6 行）。
// 举例和「少一段含义整体前移」的展开说明由输入框下方常驻的 .cron-field-hint 承担，那里本来就写了同样的内容。
var errInvalidFieldCount = &parseError{message: "定时规则必须是 5 段或 6 段，用空格分隔：" +
	"6 段是「秒 分 时 日 月 周」，5 段是「分 时 日 月 周」；" +
	"不支持 @daily、@every 1h 这类简写"}

type parseError struct {
	message string
}

func (e *parseError) Error() string {
	return e.message
}

func buildFields(parts []string, hasSecond bool) map[string]string {
	if hasSecond {
		return map[string]string{
			"second":      parts[0],
			"minute":      parts[1],
			"hour":        parts[2],
			"day":         parts[3],
			"month":       parts[4],
			"day_of_week": parts[5],
		}
	}

	return map[string]string{
		"minute":      parts[0],
		"hour":        parts[1],
		"day":         parts[2],
		"month":       parts[3],
		"day_of_week": parts[4],
	}
}

func describe(fields map[string]string, hasSecond bool) string {
	if hasSecond {
		if desc, ok := describeSimpleStep(fields["second"], "秒"); ok {
			return desc
		}
	}
	if desc, ok := describeSimpleStep(fields["minute"], "分钟"); ok {
		return desc
	}
	if desc, ok := describeSimpleStep(fields["hour"], "小时"); ok {
		return desc
	}

	minute := fields["minute"]
	hour := fields["hour"]
	day := fields["day"]
	month := normalizeMonth(fields["month"])
	dow := normalizeWeek(fields["day_of_week"])
	// 「每天 …」这几条分支要补的秒位，详见 dailySecondSuffix 的注释
	secondSuffix := dailySecondSuffix(fields, hasSecond)

	if isEvery(month) && isEvery(day) && isEvery(hour) && isEvery(minute) {
		return "每分钟"
	}
	if isEvery(month) && isEvery(day) && hour == "0" && minute == "0" {
		return "每天 00:00" + secondSuffix
	}
	// 小时段是 `9,21` 这种逗号分隔的数字列表时，逐个拼成「每天 09:50、21:50」。
	// 必须排在下面那条「每天 HH:MM」之前：那条要求小时是纯数字，含逗号会落空，
	// 一路走到兜底的「自定义 cron 表达式」。而 `10 50 9,21 * * *` 正是随机弹层
	// 「合并一条」形态的产物 —— 预览里写着人话、应用后规则条上却退化成兜底文案，
	// 同一屏里两个说法，比不给描述更像 bug。
	//
	// 这里必须连 dow 一起守：不守的话 `0 30 9,21 * * 1-5` 会被说成「每天 09:30、21:30」，
	// 而它实际只在工作日执行。兜底文案只是含糊，这种是【自信的错误】，比含糊更坏。
	// 守住之后这类表达式退回兜底「自定义 cron 表达式」，与本分支加入之前的行为一致；
	// 随机弹层产出的都是 `* * *` 形态，不受影响。前置条件因此与下面「每周」那条对齐。
	//
	// ⚠️ 既有缺陷（本轮刻意不修）：上面「每天 00:00」与下面「每天 HH:MM」两条分支同样不看 dow，
	// 所以出厂预设「周末10点」`0 0 10 * * 0,6` 一直被描述成「每天 10:00」、「每周一0点」
	// `0 0 0 * * 1` 一直被描述成「每天 00:00」。修它会一次改掉好几条出厂预设的描述，
	// 属于独立的行为变更，需要单独立项。
	if isEvery(month) && isEvery(day) && isEvery(dow) && isNumeric(minute) {
		if hours := numericHourList(hour); len(hours) > 0 {
			items := make([]string, 0, len(hours))
			for _, item := range hours {
				items = append(items, item+":"+twoDigits(minute)+secondSuffix)
			}
			return "每天 " + strings.Join(items, "、")
		}
	}
	if isEvery(month) && isEvery(day) && isNumeric(hour) && isNumeric(minute) {
		return "每天 " + twoDigits(hour) + ":" + twoDigits(minute) + secondSuffix
	}
	if isEvery(month) && day == "*" && !isEvery(dow) && isNumeric(hour) && isNumeric(minute) {
		return "每周 " + dow + " " + twoDigits(hour) + ":" + twoDigits(minute)
	}
	if month != "*" && day != "*" && isNumeric(hour) && isNumeric(minute) {
		return "每年 " + month + " " + day + "日 " + twoDigits(hour) + ":" + twoDigits(minute)
	}
	if day != "*" && isNumeric(hour) && isNumeric(minute) {
		return "每月 " + day + "日 " + twoDigits(hour) + ":" + twoDigits(minute)
	}
	return "自定义 cron 表达式"
}

// numericHourList 把 `9,21` 这种逗号分隔的纯数字小时段拆成补零后的列表（["09","21"]）。
// 不含逗号（单个小时，交给后面已有的分支处理）或任一段不是纯数字（`9,*/2`、`9-11,21` 等）
// 都返回 nil，宁可落到兜底文案也不猜。
func numericHourList(value string) []string {
	if !strings.Contains(value, ",") {
		return nil
	}
	items := strings.Split(value, ",")
	hours := make([]string, 0, len(items))
	for _, item := range items {
		item = strings.TrimSpace(item)
		if !isNumeric(item) {
			return nil
		}
		hours = append(hours, twoDigits(item))
	}
	return hours
}

// dailySecondSuffix 给「每天 HH:MM」这类描述补上 `:SS` 秒位。
//
// 只在「有秒段（6 段）且秒是非 0 的固定数字」时才补：
//   - 秒是 0 时不补，`0 50 9 * * *` 与 5 段的 `50 9 * * *` 描述保持一致，也避免让
//     出厂那 21 条预设的描述凭空多出 `:00`；
//   - 秒是 `*/10`、`0-30` 这类非固定值时不补，describe 前面的 describeSimpleStep 或兜底分支会处理。
//
// 之所以要补：随机弹层的「随机到秒」会常态产出 `10 50 9 * * *` 这种非零固定秒，
// 而原来 describe() 只在 `*/N` 形态下提秒、固定秒值一律丢掉，于是弹层预览写「每天 09:50:10」、
// 应用后规则条却写「每天 09:50」，同一屏里两个说法。
func dailySecondSuffix(fields map[string]string, hasSecond bool) string {
	if !hasSecond {
		return ""
	}
	second := fields["second"]
	if !isNumeric(second) {
		return ""
	}
	// "0"、"00" 都算零秒，不补
	if strings.Trim(second, "0") == "" {
		return ""
	}
	return ":" + twoDigits(second)
}

func describeSimpleStep(field, unit string) (string, bool) {
	if strings.HasPrefix(field, "*/") {
		return "每" + strings.TrimPrefix(field, "*/") + unit, true
	}
	return "", false
}

func normalizeWeek(value string) string {
	upper := strings.ToUpper(strings.TrimSpace(value))
	replacer := strings.NewReplacer(
		"SUN", "周日",
		"MON", "周一",
		"TUE", "周二",
		"WED", "周三",
		"THU", "周四",
		"FRI", "周五",
		"SAT", "周六",
		"0", "周日",
		"1", "周一",
		"2", "周二",
		"3", "周三",
		"4", "周四",
		"5", "周五",
		"6", "周六",
		"7", "周日",
	)
	return replacer.Replace(upper)
}

func normalizeMonth(value string) string {
	upper := strings.ToUpper(strings.TrimSpace(value))
	replacer := strings.NewReplacer(
		"JAN", "1月",
		"FEB", "2月",
		"MAR", "3月",
		"APR", "4月",
		"MAY", "5月",
		"JUN", "6月",
		"JUL", "7月",
		"AUG", "8月",
		"SEP", "9月",
		"OCT", "10月",
		"NOV", "11月",
		"DEC", "12月",
	)
	return replacer.Replace(upper)
}

func isEvery(value string) bool {
	return value == "*" || value == "?"
}

func isNumeric(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func twoDigits(value string) string {
	if len(value) == 1 {
		return "0" + value
	}
	return value
}

func GetTemplates() []map[string]string {
	return []map[string]string{
		{"name": "每分钟", "expression": "0 * * * * *", "description": "每分钟执行一次", "category": "高频"},
		{"name": "每5分钟", "expression": "0 */5 * * * *", "description": "每5分钟执行一次", "category": "高频"},
		{"name": "每10分钟", "expression": "0 */10 * * * *", "description": "每10分钟执行一次", "category": "高频"},
		{"name": "每15分钟", "expression": "0 */15 * * * *", "description": "每15分钟执行一次", "category": "高频"},
		{"name": "每30分钟", "expression": "0 */30 * * * *", "description": "每30分钟执行一次", "category": "常用"},
		{"name": "每小时", "expression": "0 0 * * * *", "description": "每小时整点执行", "category": "常用"},
		{"name": "每2小时", "expression": "0 0 */2 * * *", "description": "每2小时执行一次", "category": "常用"},
		{"name": "每6小时", "expression": "0 0 */6 * * *", "description": "每6小时执行一次", "category": "常用"},
		{"name": "每天0点", "expression": "0 0 0 * * *", "description": "每天凌晨0点执行", "category": "每天"},
		{"name": "每天6点", "expression": "0 0 6 * * *", "description": "每天早上6点执行", "category": "每天"},
		{"name": "每天9点", "expression": "0 0 9 * * *", "description": "每天上午9点执行", "category": "每天"},
		{"name": "每天12点", "expression": "0 0 12 * * *", "description": "每天中午12点执行", "category": "每天"},
		{"name": "每天18点", "expression": "0 0 18 * * *", "description": "每天下午6点执行", "category": "每天"},
		{"name": "工作日9点", "expression": "0 0 9 * * 1-5", "description": "工作日上午9点执行", "category": "工作日"},
		{"name": "工作日18点", "expression": "0 0 18 * * 1-5", "description": "工作日下午6点执行", "category": "工作日"},
		{"name": "周末10点", "expression": "0 0 10 * * 0,6", "description": "周末上午10点执行", "category": "周末"},
		{"name": "每周一0点", "expression": "0 0 0 * * 1", "description": "每周一凌晨0点执行", "category": "每周"},
		{"name": "每月1日0点", "expression": "0 0 0 1 * *", "description": "每月1日凌晨0点执行", "category": "每月"},
		{"name": "每月15日0点", "expression": "0 0 0 15 * *", "description": "每月15日凌晨0点执行", "category": "每月"},
		{"name": "每10秒", "expression": "*/10 * * * * *", "description": "每10秒执行一次", "category": "秒级"},
		{"name": "每30秒", "expression": "*/30 * * * * *", "description": "每30秒执行一次", "category": "秒级"},
	}
}
