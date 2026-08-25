package cron

import (
	"strings"
	"testing"
	"time"
)

func TestParseMatchesSchedulerParser(t *testing.T) {
	cases := []string{
		"0 */5 * * * *",
		"0 9 * JAN MON",
		"0 0 L * *",
		"0 0 15W * *",
		"0 0 * * MON#2",
	}

	for _, expr := range cases {
		parser, _, err := parserForParts(strings.Fields(expr))
		_, parseErr := parser.Parse(expr)
		expectValid := err == nil && parseErr == nil

		result := Parse(expr)
		if result.Valid != expectValid {
			t.Fatalf("unexpected validity for %q: got %v want %v", expr, result.Valid, expectValid)
		}
	}
}

func TestNextRunTimesMatchesSchedule(t *testing.T) {
	expr := "0 */5 * * * *"
	schedule, err := parseSchedule(expr)
	if err != nil {
		t.Fatalf("parseSchedule error: %v", err)
	}

	got := NextRunTimes(expr, 3)
	if len(got) != 3 {
		t.Fatalf("expected 3 next run times, got %d", len(got))
	}

	cursor := time.Now()
	for i, next := range got {
		expected := schedule.Next(cursor)
		if !next.Equal(expected) {
			t.Fatalf("unexpected next run at index %d: got %v want %v", i, next, expected)
		}
		cursor = expected
	}
}

// TestParseInvalidFieldCount 除了「段数不合法要被拒绝」，还要钉住那条中文错误文案。
//
// errInvalidFieldCount 是段数不合法时唯一的报错出口，会原样渲染成面板上的红色错误徽标。
// 只说一句英文的 "cron expression must have 5 or 6 fields"，用户既不知道 5 段和 6 段
// 分别怎么排，也不知道自己抄来的 @daily / @every 1h 为什么不认。所以这里必须钉住两层含义：
//  1. 合法段数是 5 段或 6 段；
//  2. @daily 这类简写【不支持】（它们段数对不上，根本进不到解析器）。
//
// 刻意只断言几个关键片段、不断言整句：这条文案要迁就徽标宽度，以后调标点、补例子都很正常，
// 整句断言会让每次措辞微调都无谓地变红，最后大家干脆把断言删了。
func TestParseInvalidFieldCount(t *testing.T) {
	// 少一段、多一段、以及用户最容易照着别处教程抄来的两种简写。
	for _, expr := range []string{"* * * *", "* * * * * * *", "@daily", "@every 1h"} {
		result := Parse(expr)
		if result.Valid {
			t.Fatalf("表达式 %q 段数不合法，应当被拒绝", expr)
		}
		for _, fragment := range []string{"5 段或 6 段", "不支持", "@daily"} {
			if !strings.Contains(result.Error, fragment) {
				t.Fatalf("表达式 %q 的错误文案缺少关键片段 %q（不能退回英文/只说一句「段数错误」）：got %q",
					expr, fragment, result.Error)
			}
		}
	}
}

// TestDescribeDailyHoursAndSeconds 锁住「逗号小时列表」与「非零固定秒」这两条描述分支。
// 它们是随机弹层（合并一条 / 随机到秒）的常态产物：弹层预览写人话、应用后规则条却退化成
// 兜底文案的话，同一屏里会出现两个说法。同时把「不该猜的就别猜」的几种形态一并钉死。
func TestDescribeDailyHoursAndSeconds(t *testing.T) {
	cases := []struct {
		expression string
		want       string
		reason     string
	}{
		// 逗号小时列表：随机弹层「合并一条」形态
		{"10 50 9,21 * * *", "每天 09:50:10、21:50:10", "逗号小时 + 非零固定秒"},
		{"0 0 9,12,18 * * *", "每天 09:00、12:00、18:00", "逗号小时 + 零秒不补秒位"},
		// 单个小时：走既有的「每天 HH:MM」分支，秒位由 dailySecondSuffix 决定补不补
		{"10 50 9 * * *", "每天 09:50:10", "非零固定秒要显示出来"},
		{"0 50 9 * * *", "每天 09:50", "零秒不补，与 5 段的 50 9 * * * 保持一致"},
		{"30 0 0 * * *", "每天 00:00:30", "「每天 00:00」分支也要能带秒位"},
		// 不该猜的：宁可落兜底也不给出自信的错误描述
		{"0 30 9,21 * * 1-5", "自定义 cron 表达式", "只在工作日执行，不能说成「每天」"},
		{"0 0 9-11,21 * * *", "自定义 cron 表达式", "小时段含区间，numericHourList 刻意不展开"},
		// 既有行为不能被逗号小时分支截胡
		{"0 */5 * * * *", "每5分钟", "describeSimpleStep 优先级最高"},
		{"0 0 * * *", "每天 00:00", "5 段表达式没有秒位"},
	}

	for _, item := range cases {
		result := Parse(item.expression)
		if !result.Valid {
			t.Fatalf("表达式 %q 应当合法，却报错：%s", item.expression, result.Error)
		}
		if result.Description != item.want {
			t.Fatalf("表达式 %q（%s）描述不符：got %q want %q",
				item.expression, item.reason, result.Description, item.want)
		}
	}
}

// TestDescribeTemplatesSnapshot 把出厂预设的描述整体钉成快照，防止以后有人改 describe()
// 时把某条预设打回兜底文案，或者悄悄改掉别的预设的说法。
//
// 快照里有 5 条【当前实际输出就是错的】，是既有缺陷不是本轮引入的，所以按现状钉住而不是按理想值钉：
//   - 「每小时」`0 0 * * * *` 落在兜底「自定义 cron 表达式」：hour 是裸 `*` 而不是 `*/N`，
//     describeSimpleStep 认不出来，后面的分支又都要求 hour 是纯数字。
//   - 「工作日9点」「工作日18点」「周末10点」「每周一0点」被说成「每天 …」：
//     「每天 00:00」和「每天 HH:MM」两条分支不看 dow（详见 describe() 里的注释）。
//
// 哪天要修这些缺陷，请连同本快照一起改，这样改动范围会被显式地摆出来。
func TestDescribeTemplatesSnapshot(t *testing.T) {
	snapshot := map[string]string{
		"0 * * * * *":    "每分钟",
		"0 */5 * * * *":  "每5分钟",
		"0 */10 * * * *": "每10分钟",
		"0 */15 * * * *": "每15分钟",
		"0 */30 * * * *": "每30分钟",
		"0 0 * * * *":    "自定义 cron 表达式",
		"0 0 */2 * * *":  "每2小时",
		"0 0 */6 * * *":  "每6小时",
		"0 0 0 * * *":    "每天 00:00",
		"0 0 6 * * *":    "每天 06:00",
		"0 0 9 * * *":    "每天 09:00",
		"0 0 12 * * *":   "每天 12:00",
		"0 0 18 * * *":   "每天 18:00",
		"0 0 9 * * 1-5":  "每天 09:00",
		"0 0 18 * * 1-5": "每天 18:00",
		"0 0 10 * * 0,6": "每天 10:00",
		"0 0 0 * * 1":    "每天 00:00",
		"0 0 0 1 * *":    "每月 1日 00:00",
		"0 0 0 15 * *":   "每月 15日 00:00",
		"*/10 * * * * *": "每10秒",
		"*/30 * * * * *": "每30秒",
	}

	templates := GetTemplates()
	if len(templates) != len(snapshot) {
		t.Fatalf("出厂预设数量与快照不一致：预设 %d 条、快照 %d 条，改了预设就要同步改快照",
			len(templates), len(snapshot))
	}

	for _, template := range templates {
		expression := template["expression"]
		want, ok := snapshot[expression]
		if !ok {
			t.Fatalf("预设 %q（%s）不在快照里，新增预设时请一并补进来", expression, template["name"])
		}

		result := Parse(expression)
		if !result.Valid {
			t.Fatalf("预设 %q（%s）解析失败：%s", expression, template["name"], result.Error)
		}
		if result.Description != want {
			t.Fatalf("预设 %q（%s）描述变了：got %q want %q",
				expression, template["name"], result.Description, want)
		}
	}
}
