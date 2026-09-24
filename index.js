(() => {
  "use strict";

  const {
    Plugin,
    showMessage,
    fetchPost,
    openTab,
  } = require("siyuan");

  const NAME = "轻迹";
  const DATA_KEY = "settings";
  const DOCK_TYPE = "TimeTrailDock";
  /* 侧栏 Dock 的标题。它同时出现在两个地方：侧栏面板的标题、设置 → 快捷键里的条目名。
     坑：思源会把这份标题存进工作空间的本地存储（data/storage/local.json 的
     local-plugin-docks），之后**一直拿存档覆盖插件里的值** —— 所以光改这个常量，
     老用户界面上一辈子显示旧名（轻迹曾经叫「时迹」，就是这么被冻住的）。
     配套的 _syncDockMeta() 会在注册 Dock 之前把存档里的旧标题校正过来。 */
  const DOCK_TITLE = NAME;
  /* 两个快捷键，各管各的（记号跟思源默认键位同一套：⌘ = Ctrl、⌥ = Alt，
     Windows 上显示成 Ctrl+Alt+X）：
       TAB_HOTKEY  —— 「打开轻迹」命令：唤出 / 聚焦日历标签页，也就是主区域那个 tab；
       DOCK_HOTKEY —— 侧栏面板本体：展开 / 收起那个面板。
     为什么必须分成两条两个键：Dock 的快捷键语义固定是「开关这个面板」，
     唤不出标签页；命令反过来也开不了面板。两个都要，就只能各挂各的。 */
  const TAB_HOTKEY = "⌥⌘N";
  const DOCK_HOTKEY = "⌥⌘O";
  /* 日历标签页：addTab 注册用的类型名；openTab 时以 name + 该值作为 custom.id */
  const CAL_TAB_TYPE = "TimeTrailCalendar";

  /* 日历标签页里已经接了视图的段位。八个都接上了 ——
     以后再加段位，不在这里的点了只切高亮、不换内容。 */
  const CAL_TAB_VIEWS = ["month", "week", "three", "day", "table", "habit", "stats", "metric"];

  /* ---- 指标（从记录内容里抽数值画折线） ----
     指标 = 一条「从记录内容里抽出来的数值序列」：内容里写「体重 65.5」，就有对应的体重走势。
     定义只存在插件设置里（data.metricGroups），解析**只读不写** ——
     不写回文档、不加块属性，卸载插件不会在用户笔记里留下任何痕迹。
     一个指标的要素（管理弹窗里逐项可改）：
       match    匹配词：内容里出现任一才算这条记录（如「血糖」）
       exclude  排除词：出现就跳过（比如同时记了别人的数据，用词一挡就不算自己的）
       split    分线词：把同一指标拆成多条折线（血糖拆成空腹 / 餐后）
       pick     同一条内容里有多个数字时怎么取（最后 / 平均 / 最大 / 最小 / 求和）
       kind     数值类型：数字 / 时长（时长认「7小时30分」「7.5h」「7:30」）
       scale    默认尺度：日 / 周 / 月 —— 同一份数据换个粒度看，这就是「看大类」
       bucket   同一个桶里落进多条记录时怎么并成一个点
       decimals 小数位、unit 单位、target 目标值（可选）、color 颜色
     存储结构照抄 typeGroups（{name, desc, items}），管理弹窗复用那套 .tt-modal 骨架。 */
  const METRIC_PICKS = [
    { value: "last", label: "最后一个" },
    { value: "first", label: "第一个" },
    { value: "max", label: "最大值" },
    { value: "min", label: "最小值" },
    { value: "avg", label: "平均值" },
    { value: "sum", label: "求和" },
  ];
  const METRIC_BUCKETS = [
    { value: "last", label: "最后一条" },
    { value: "first", label: "第一条" },
    { value: "avg", label: "平均值" },
    { value: "max", label: "最大值" },
    { value: "min", label: "最小值" },
    { value: "sum", label: "求和" },
  ];
  const METRIC_SCALES = [
    { value: "day", label: "日" },
    { value: "week", label: "周" },
    { value: "month", label: "月" },
  ];
  /* 数值类型：auto 是默认档（UI 不再让人选，解析时自己判），
     number / duration 留着给老配置与「就是想强制按某种读」的场合 */
  const METRIC_KINDS = [
    { value: "auto", label: "自动" },
    { value: "number", label: "数字" },
    { value: "duration", label: "时长" },
  ];
  /* 指标段位看多长一段（近 N 天；0 = 全部，从最早一条记录那天算起） */
  const METRIC_SCOPES = [
    { value: "30", label: "近 30 天" },
    { value: "90", label: "近 90 天" },
    { value: "365", label: "近一年" },
    { value: "0", label: "全部" },
  ];
  const METRIC_SCOPE_DEFAULT = "90";

  /* ---- 习惯视图 ----
     习惯 = 用户从「记录类型」里自己挑出来的几个（挑哪些存在 settings.habitTypes，
     是个类型名数组）。挑中的类型才追踪，没挑的不算 —— 不然「记录」这种量大又杂的
     类型会把习惯页塞满，看不出什么。
     目标模型四要素（settings.habitConfig，每个习惯各一份）：
       单位 unit      = 次数 | 分钟（当天该类型记了几次 / 累计多少分钟）
       方向 dir       = 好习惯（达到目标算达标）| 坏习惯（低于目标算达标，如「玩手机 < 2 小时」）
       周期 period    = 日目标 | 周目标 | 月目标
       目标 goal      = 一个数字；周 / 月目标另有计法 goalUnit = 合计（整段周期累计）| 天数（周期内达标天数）
     年热力图 5 级色的来源：
       日目标 → 当天值与目标的倍数（≥1 倍 = 等级 1 … ≥5 倍 = 等级 5；
                坏习惯反过来，达标不上色、超出才上色，超得越多颜色越深）；
       周 / 月目标 → 周期内**累计**进度的步进带（有记录 = 等级 1，≥25% = 2，≥50% = 3，
                ≥75% = 4，≥100% = 5）—— 一天一天看着累计条往目标走。
     连续 / 最长按各自周期结算：日目标数天、周目标数周、月目标数月。 */
  const HABIT_UNITS = [
    { value: "count", label: "次数" },
    { value: "min", label: "分钟" },
  ];
  /* 旧版 5 档阶梯已退役：等级色改由目标值自动推导（见文件头「习惯视图」说明），
     这里只保留「目标值兜底」—— 迁移不出目标值时按单位给默认 */
  const HABIT_GOAL_DEFAULT = { count: 1, min: 30 };
  const HABIT_DIRS = [
    { value: "good", label: "好习惯" },
    { value: "bad", label: "坏习惯" },
  ];
  const HABIT_PERIODS = [
    { value: "day", label: "日" },
    { value: "week", label: "周" },
    { value: "month", label: "月" },
  ];
  const HABIT_PERIOD_LABEL = { day: "每天", week: "每周", month: "每月" };
  const HABIT_GUNITS = [
    { value: "value", label: "合计" },
    { value: "days", label: "天数" },
  ];
  /* 习惯「查看窗口」的快捷预设：存的是**名字**不是日期 —— 相对「今天」每次现算，
     所以「本月」到了下个月自己就是新的一月，不会停留在旧区间。
     留空的 value 表示「跟随顶部」（不存任何东西），这也是老数据的状态。 */
  const HABIT_VIEW_PRESETS = [
    { value: "", label: "跟随顶部" },
    { value: "month", label: "本月" },
    { value: "prevMonth", label: "上月" },
    { value: "d7", label: "近 7 天" },
    { value: "d30", label: "近 30 天" },
    { value: "d100", label: "近 100 天" },
    { value: "custom", label: "自定义" },
  ];
  /* 预设名 → 胶囊上显示的短标签（custom 的标签由具体起止日期算出来） */
  const HABIT_VIEW_LABEL = {
    month: "本月",
    prevMonth: "上月",
    d7: "近 7 天",
    d30: "近 30 天",
    d100: "近 100 天",
  };
  /* 门槛的单位后缀：3 次 / 30 分 */
  const habitUnitLabel = (unit, v) => (unit === "min" ? `${v} 分` : `${v} 次`);
  /* 目标一句话：每天 ≥ 5 次 / 每周 ≥ 3 天 / 每月 < 10 次 —— 卡片上的小徽标用。
     设了时间范围再追加一段「9月1日 ~ 9月24日」（只填一头的那头显示 …），
     四种卡片（年 / 周 / 月 / 日）头部都走这里，改一处全都有。 */
  const habitDayShort = (s) => {
    const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${+m[2]}月${+m[3]}日` : "";
  };
  const habitGoalText = (cfg) => {
    const p = HABIT_PERIOD_LABEL[cfg.period] || "每天";
    if (cfg.period !== "day" && cfg.goalUnit === "days") {
      return `${p} ≥ ${cfg.goal} 天`;
    }
    const base = `${p} ${cfg.dir === "bad" ? "<" : "≥"} ${habitUnitLabel(cfg.unit, cfg.goal)}`;
    if (cfg.start || cfg.end) {
      return `${base} · ${cfg.start ? habitDayShort(cfg.start) : "…"} ~ ${cfg.end ? habitDayShort(cfg.end) : "…"}`;
    }
    return base;
  };

  /* ---- 日历数据源 ----
     lifelog = 我们自己记的 LifeLog 记录（默认，读块属性）；
     docs    = 思源里**创建的文档**，按创建时间排到日历上。 */
  const CAL_SOURCE_OPTIONS = [
    { value: "lifelog", label: "LifeLog 记录" },
    { value: "docs", label: "创建的文档" },
  ];
  const CAL_SOURCE_DEFAULT = "lifelog";
  const normCalSource = (v) => (v === "docs" ? "docs" : CAL_SOURCE_DEFAULT);

  /* 「创建的文档」一次最多取多少条：本年的全部文档，这个值只是兜底 ——
     一年写的文档数真超过它就把这个数字调大，别让它静默截断。 */
  const CAL_DOCS_LIMIT = 999999;
  /* 记录源查询的上限：设一个「实际上限」—— 正常使用等于不设限，
     天花板只防极端情况（误导入产生海量块时拖垮查询）。
     列都是挑过的（不拖正文），十万行级也在毫秒到百毫秒之间。 */
  const CAL_RECORDS_LIMIT = 999999;

  /* 表格视图的列定义：一处定义同时长出 colgroup 与表头 ——
     加列 / 改列宽 / 改列名只动这里，表头文字与列宽永远对得上。
     icon 必须是思源真实存在的图标 id（litheness 里核对过：
     iconClock / iconTag / iconParagraph / iconHistory 都在，写错会渲染成空框）。
     「时间」列 145px 是配着它那 53px 左缩进算的（见 `.north-caltab-table-row td.north-caltab-table-time`）：
     53（缩进）+ 78（「03:57 - 04:57」这种 13 字符实测宽度）+ 10（右内边距）= 141，留几像素余量。
     时间文字定长，按 13 字符算就够；缩进量要改，这一列跟着加减。 */
  const CAL_TABLE_COLS = [
    { key: "time", label: "时间", icon: "iconClock", width: "145px" },
    { key: "type", label: "类型", icon: "iconTag", width: "92px" },
    { key: "content", label: "内容", icon: "iconParagraph", width: "" },
    { key: "dur", label: "时长", icon: "iconHistory", width: "76px", num: true },
  ];

  /* ---- 时间轴视图（周 / 三日 / 日）尺寸 ----
     HOUR 是一小时的基准像素高度：小时高是「弹性」的 —— 记录密集的小时会被
     _calTimelineLayout 撑高，稀疏小时维持这个值；最终整天总高由 JS 内联写成
     CSS 变量 --tt-wv-total 传给样式表，这里就是基准的唯一来源。
     MIN_BLOCK 是块的最小高度，避免极短的活动被压成一条看不见的线。
     SHOW_TIME 是「放得下两行」的高度门槛 —— 低于它就改成标题与时间同一行，
     硬塞两行会被裁掉半行，比挤一行更难看。
     DEFAULT_MIN 给「没有参照」的那一条用（结束模式的当天首条、开始模式的当天末条）：
     它没有相邻记录可推算，只能按这个默认跨度摆一块，且不计入时长统计。 */
  const WEEK_HOUR_H = 40;
  const WEEK_MIN_BLOCK_H = 22;
  const WEEK_SHOWTIME_H = 36;
  const WEEK_DEFAULT_MIN = 30;
  /* 相邻块之间的最小空隙：记录工具的记录常常几分钟一条，块又保底 22px 高，
     按时间比例硬摆必然叠字。摆块时保证相邻块至少隔这么多像素。 */
  const WEEK_EVENT_GAP = 2;
  /* 进入时间轴视图时先滚到这里（小时数）：活动基本都在白天，从 00:00 开始要滚很久 */
  const WEEK_INITIAL_HOUR = 7;

  /* 思源块 / 文档 ID，避免把外部文本拼进 SQL */
  const ID_RE = /^[0-9a-z-]{8,64}$/;

  /* 记录行格式：19:52 记录：内容
     时间与类型之间为空白；类型为不含空白与冒号的一串；内容取其后全部文字。 */
  const LINE_RE = /^(\d{1,2}):(\d{2})(?::\d{2})?\s+([^：:\s]+)[：:]\s*(.+)$/;
  /* 同上，但只匹配到冒号为止、不要求后面有内容。
     用来判断「类型是不是已经敲定了」—— 着色看它，落库仍看 LINE_RE。 */
  const LINE_TYPED_RE = /^(\d{1,2}):(\d{2})(?::\d{2})?\s+([^：:\s]+)[：:]/;

  /* 块属性名前缀：custom-<prefix>-<key>
     两端固定不变：custom 与 key（content / type / time / date / created / updated 共 6 个），
     只有中间的 prefix 允许用户自定义，默认 lifelog。 */
  const DEFAULT_ATTR_PREFIX = "lifelog";

  /* 规范化用户输入的前缀：
     去掉 custom- 前缀，只保留小写字母、数字与连字符，压缩连续连字符，空值回退默认。 */
  const normAttrPrefix = (value) => {
    let s = String(value == null ? "" : value)
      .trim()
      .toLowerCase();
    if (s.indexOf("custom-") === 0) s = s.slice("custom-".length);
    s = s
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "");
    if (s.length > 24) s = s.slice(0, 24).replace(/-+$/g, "");
    return s || DEFAULT_ATTR_PREFIX;
  };

  /* 动态标记样式的 style 元素 id：按块属性把类型颜色映射到 --tt-c */
  const MARK_STYLE_ID = "tt-mark-style";

  /* 「思维导图视图」范围识别，用法见 _isInListMindmap()。
     思源两代之间把这套记号改过名，所以显式记号 + 模糊兜底都留着 ——
     少认一个，就会在对应版本上复发（3.8.6-alpha 已实测复发过一次）：
       3.8.5       容器 .list-mindmap，列表块带 data-list-mindmap-rendered
       3.8.6-alpha 容器 .mindmap-view，块带 data-mindmap-view-rendered，
                   专用块类型 NodeMindmap / 节点 NodeMindmapItem
     模糊兜底按「类名或块类型里带 mindmap」匹配祖先：思源这套记号不管怎么改名，
     mindmap 这个词一直在，以后再改名也不会又漏一次。 */
  const LIST_MINDMAP_SELECTOR = [
    /* 显式记号：两代写法都列上，改名前后哪个在都能命中 */
    ".list-mindmap",
    ".mindmap-view",
    "[data-list-mindmap-rendered]",
    "[data-mindmap-view-rendered]",
    "[custom-sy-list-mindmap]",
    /* 兜底：类名（list-mindmap__x / mindmap-view__x）或块类型（NodeMindmap[Item]）带 mindmap */
    '[class*="mindmap"]',
    '[data-type*="Mindmap"]',
  ].join(", ");

  /* 下划线线宽：默认 0.75px，可在插件设置「控制设置 / 下划线粗细」中调整。
     0 = 无，即不画线（只保留可选的「记录底色」）。
     这一档是给「和别的插件叠在一起」准备的：叶归等插件也会给 LifeLog 记录画底线，
     两家同时开着时两条线会挨在一起、看起来比设定值粗一倍。把这边设成「无」，
     标记还在（属性、底色、各视图照旧），只是不再抢那条线。 */
  const DEFAULT_MARK_LINE_WIDTH = 0.75;
  const MARK_LINE_OPTIONS = [
    { value: "0", label: "无" },
    ...[0.5, 0.75, 1, 1.5, 2].map((w) => ({ value: String(w), label: `${w}px` })),
  ];

  /* 规范化线宽：只接受候选档位（含 0 = 无），其余一律回退默认值。
     注意空值要走兜底：Number(null) 与 Number("") 都是 0，会被误判成「无」，
     所以先挡掉 null / undefined / 空串。 */
  const normLineWidth = (value) => {
    if (value === null || value === undefined || value === "") {
      return DEFAULT_MARK_LINE_WIDTH;
    }
    const n = Number(value);
    return MARK_LINE_OPTIONS.some((o) => Number(o.value) === n)
      ? n
      : DEFAULT_MARK_LINE_WIDTH;
  };

  /* 记录行底色：默认关闭（0），可选 1% 到 10%，其中 3% 为推荐档 */
  const DEFAULT_MARK_BG_OPACITY = 0;
  const MARK_BG_OPACITY_RANGE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const RECOMMENDED_MARK_BG_OPACITY = 3;
  const MARK_BG_OPTIONS = [
    { value: "0", label: "关闭" },
    ...MARK_BG_OPACITY_RANGE.map((n) => ({
      value: String(n),
      label: n === RECOMMENDED_MARK_BG_OPACITY ? `${n}%（推荐）` : `${n}%`,
    })),
  ];

  /* 规范化底色不透明度：0 表示关闭，只接受 1 到 10 的整数，其余回退默认 */
  const normBgOpacity = (value) => {
    const n = Math.round(Number(value));
    return MARK_BG_OPACITY_RANGE.indexOf(n) >= 0 ? n : DEFAULT_MARK_BG_OPACITY;
  };

  /* 记录范围：决定哪些文档里的「时间 类型：内容」会被识别并打标。
     daily    —— 只认每日笔记（带 custom-dailynote-* 属性的文档），即旧行为；
     notebook —— 「日记笔记本」下的所有文档；
     all      —— 任意文档。 */
  const DEFAULT_RECORD_SCOPE = "daily";
  const RECORD_SCOPE_OPTIONS = [
    { value: "daily", label: "仅日记" },
    { value: "notebook", label: "指定笔记本" },
    { value: "all", label: "全部文档" },
  ];
  const normRecordScope = (value) =>
    RECORD_SCOPE_OPTIONS.some((o) => o.value === value)
      ? value
      : DEFAULT_RECORD_SCOPE;

  /* ---- 时间计算模式 ----
     决定一条记录里那个时间点怎么解释，全部视图共用同一套口径：
     Dock 时间线、日历时间轴的块位置、表格的起止与时长、统计的类型用时，
     都按这里选的模式算 —— 换模式只改解释方式，不改任何已存的数据。
     end   —— 结束模式（默认）：节点时间为结束时间，区间从同日上一条算到当前；
     start —— 开始模式：节点时间为开始时间，区间从当前算到下一条。
     两头没有参照的那一条（结束模式的当天首条、开始模式的当天末条）不编区间、
     也不计入时长 —— 只显示节点时间本身，宁可不计也不编一个 30 分钟出来；
     Dock 时间线在开始模式下会跨天拆段
     （当天算到 24:00，余下一段挂到次日开头）。
     记录的时间写成「08:30 - 09:30」这种显式区间时，无论选哪个模式都直接采用，
     不再按模式推 —— 用户自己写明的起止优先。
     注：结束模式在**日历的日视图里按天各算各的**，不跨天接前一天那条，
     否则一条隔夜记录会横跨整整一晚，撑出一个没有数据的长块。 */
  const DEFAULT_TIME_MODE = "end";
  const TIME_MODE_OPTIONS = [
    { value: "end", label: "结束模式" },
    { value: "start", label: "开始模式" },
  ];
  const normTimeMode = (value) =>
    TIME_MODE_OPTIONS.some((o) => o.value === value)
      ? value
      : DEFAULT_TIME_MODE;

  /* 底边线取类型色的百分比：颜色比底色深，保证线条清晰 */
  const MARK_LINE_MIX = 60;

  /* ===================== 指标：定义归一化 ===================== */

  /* 关键词 / 排除词 / 分线词都是「一个输入框里写多个词」：
     空格、逗号（半角全角）、顿号、分号、竖线都当分隔符，用户怎么写都行。 */
  const metricKw = (raw) =>
    String(raw == null ? "" : raw)
      .split(/[\s,，、;；|]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  /* 指标定义归一化：任何一项缺失 / 写坏都回退到安全值，
     这样后面所有解析代码都不用再防 undefined（跟 normRecordScope 那套一个思路）。 */
  const normMetric = (raw) => {
    const m = raw && typeof raw === "object" ? raw : {};
    const s = (v) => String(v == null ? "" : v).trim();
    const oneOf = (list, v, dflt) =>
      list.some((o) => o.value === v) ? v : dflt;
    const dec = Math.round(Number(m.decimals));
    const target = s(m.target) === "" ? null : Number(m.target);
    return {
      name: s(m.name),
      unit: s(m.unit),
      color: safeColor(m.color) || DEFAULT_TYPE_COLOR,
      match: s(m.match),
      /* 绑定的记录类型（"" = 不限）。指标先按类型圈定记录，再在内容里找匹配词 ——
         类型是可选条件，不写就还是「全库找词」的老行为（老配置因此零迁移）。 */
      type: s(m.type),
      exclude: s(m.exclude),
      split: s(m.split),
      /* 数值类型默认「自动」：内容里带时长单位就按时长读，否则按普通数字读
         （少一个要用户做选择的控件；老配置里写死的 number / duration 照旧生效） */
      kind: oneOf(METRIC_KINDS, m.kind, "auto"),
      pick: oneOf(METRIC_PICKS, m.pick, "last"),
      scale: oneOf(METRIC_SCALES, m.scale, "day"),
      /* 桶内留空 = 跟随「取值」（解析时按 metric.bucket || metric.pick 处理） */
      bucket: METRIC_BUCKETS.some((o) => o.value === m.bucket) ? m.bucket : "",
      decimals: Number.isFinite(dec) ? Math.max(0, Math.min(4, dec)) : 1,
      target: target !== null && Number.isFinite(target) ? target : null,
    };
  };

  /* 指标表归一化：丢掉没有名字的指标、彻底空的组。
     组名允许为空（用户正在输入的那一刻），只要有成员就留着。 */
  const normMetricGroups = (raw) => {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((g) => g && typeof g === "object")
      .map((g) => ({
        name: String(g.name == null ? "" : g.name).trim(),
        desc: typeof g.desc === "string" ? g.desc : "",
        /* 名称允许为空：解析时用匹配词里第一个词当显示名（见 _metrics），
           所以「只填了一个匹配词就保存」的指标不会被丢掉 */
        items: (Array.isArray(g.items) ? g.items : [])
          .map(normMetric)
          .filter((m) => m.name || metricKw(m.match).length),
      }))
      .filter((g) => g.name || g.items.length);
  };

  /* HTML 转义，用于把文本拼进 innerHTML */
  const escapeHtml = (value) =>
    String(value == null ? "" : value).replace(
      /[&<>"']/g,
      (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  /* 属性选择器内的取值转义：反斜杠、双引号，并把换行压成空格 */
  const cssAttrValue = (value) =>
    String(value == null ? "" : value)
      .replace(/[\r\n]+/g, " ")
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');

  /* 颜色值白名单：只接受 #hex、rgb()/hsl() 与颜色关键字，避免任意文本拼进样式表 */
  const safeColor = (value) => {
    const s = String(value == null ? "" : value).trim();
    if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
    if (/^(rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)$/i.test(s)) return s;
    if (/^[a-z]{3,20}$/i.test(s)) return s;
    return "";
  };

  /* ============================================================
   * 农历 / 节气 / 节日数据
   * ============================================================ */

  /* 农历压缩数据表（1900-2049），下标 = 年份 - 1900。
     位含义：
       低 4 位         闰月月份（0 表示当年无闰月）
       第 5 至 16 位   正月到十二月的大小月，1 为 30 天、0 为 29 天，由高位到低位排列
       第 17 位        闰月天数，1 为 30 天、0 为 29 天
     数据与轻语 getLunarDate 保持 1:1，因此农历部分的结果与轻语一致。 */
  const LUNAR_DATA = [
    0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
    0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
    0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
    0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
    0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
    0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5d0, 0x14573, 0x052d0, 0x0a9a8, 0x0e950, 0x06aa0,
    0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
    0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b5a0, 0x195a6,
    0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
    0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0,
    0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
    0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
    0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
    0x05aa0, 0x076a3, 0x096d0, 0x04bd7, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
    0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
  ];

  /* 农历日名（初一至三十） */
  const LUNAR_DAY_NAMES = [
    "初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十",
    "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
    "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十",
  ];

  /* 农历月名（正月起） */
  const LUNAR_MONTH_NAMES = ["正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "腊"];

  /* 农历节日，键为「月-日」 */
  const LUNAR_HOLIDAYS = {
    "1-1": "春节", "1-15": "元宵节", "5-5": "端午节", "7-7": "七夕",
    "8-15": "中秋节", "9-9": "重阳节", "12-30": "除夕",
  };

  /* 公历节日，键为「月-日」，与轻语同一份列表 */
  const SOLAR_HOLIDAYS = {
    "1-1": "元旦", "2-14": "情人节", "3-8": "妇女节", "3-12": "植树节",
    "4-1": "愚人节", "5-1": "劳动节", "5-4": "青年节", "6-1": "儿童节",
    "7-1": "建党节", "8-1": "建军节", "9-10": "教师节", "10-1": "国庆节",
    "10-31": "万圣节", "12-24": "平安夜", "12-25": "圣诞节",
  };

  /* 二十四节气名，小寒起算 */
  const SOLAR_TERM_NAMES = [
    "小寒", "大寒", "立春", "雨水", "惊蛰", "春分", "清明", "谷雨",
    "立夏", "小满", "芒种", "夏至", "小暑", "大暑", "立秋", "处暑",
    "白露", "秋分", "寒露", "霜降", "立冬", "小雪", "大雪", "冬至",
  ];

  /* 节气近似算法的基准偏移（分钟），配合下面的 _solarTermDay 使用 */
  const SOLAR_TERM_INFO = [
    0, 21208, 42467, 63836, 85337, 107014, 128867, 150921, 173149, 195551, 218072, 240693,
    263343, 285989, 308563, 331033, 353350, 375494, 397447, 419210, 440795, 462224, 483532, 504758,
  ];

  /* 农历与节气可计算的年份范围，超出则不做展示 */
  const LUNAR_MIN_YEAR = 1900;
  const LUNAR_MAX_YEAR = 2049;

  /* 默认类型分组：首次使用时填入 settings.typeGroups；用户可在插件设置中自由增删、改色与排序 */
  const DEFAULT_TYPE_GROUPS = [
    {
      name: "固定",
      color: "#d9d9d9",
      desc: "必须要做的事情。比如吃饭、睡觉。",
      items: [
        { name: "固", color: "#d9d9d9" },
        { name: "固定", color: "#d9d9d9" },
      ],
    },
    {
      name: "成长",
      color: "#95de64",
      desc: "为个人成长而做的事情。比如学习、阅读、事业。",
      items: [
        { name: "增", color: "#95de64" },
        { name: "学习", color: "#95de64" },
        { name: "阅读", color: "#95de64" },
        { name: "事业", color: "#95de64" },
      ],
    },
    {
      name: "工作",
      color: "#fadb14",
      desc: "为了生活不得不做的。比如工作。（注：个人事业不应归类于此）",
      items: [{ name: "工作", color: "#fadb14" }],
    },
    {
      name: "荒废",
      color: "#ff4d4f",
      desc: "与成长无关的事情。不能单纯的将娱乐活动归于此类，比如有的人打游戏就是工作。",
      items: [
        { name: "荒废", color: "#ff4d4f" },
        { name: "废", color: "#ff4d4f" },
        { name: "娱乐", color: "#ff4d4f" },
        { name: "玩", color: "#ff4d4f" },
      ],
    },
    {
      name: "其他",
      color: "#36cfc9",
      desc: "其他未分类、或不知道怎么分类的事情，都可以先放到这里。你可以随时调整它们（从该类下删除，再在工作、增等类型下新增）。",
      items: [
        { name: "家庭", color: "#36cfc9" },
        { name: "家", color: "#36cfc9" },
        { name: "朋友", color: "#d4a373" },
        { name: "友", color: "#d4a373" },
      ],
    },
  ];
  /* 新建类型时按使用顺序取色 */
  const PALETTE = [
    "#4c8dff", "#2fbf71", "#00b8a9", "#ff5964",
    "#ffb020", "#7c6cff", "#ff7ac2", "#13c2c2",
    "#a0d911", "#ffc53d", "#36cbcb", "#f759ab",
  ];
  /* 未在用户配置中找到的类型使用的兜底色 */
  const DEFAULT_TYPE_COLOR = "#888888";

  /* 取色面板的「系统预设颜色」：前两行沿用 PALETTE（与新建类型的取色顺序同源，
     所以系统刚分配给某类型的颜色，在这儿一眼就能找到），第三行补灰阶 ——
     记录底色、中性配色都用得上，整屏全是彩块反而不好挑。 */
  const COLOR_PRESETS = PALETTE.concat([
    "#ffffff", "#d9d9d9", "#a6a6a6", "#737373", "#404040", "#000000",
  ]);
  /* 「最近使用颜色」最多记住几条 */
  const RECENT_COLOR_MAX = 12;
  /* 取色面板挂在 body 上定位，层级要盖过两个弹窗：类型管理 9999 / 设置 9990 */
  const CPICKER_Z = 10050;

  /* ============ 颜色换算（取色面板内部用） ============
     面板的编辑态保持 HSV + 透明度：拖饱和度/明度面板时色相对得上，
     若用 RGB 三通道来回换算，灰色区（s = 0）会把色相直接丢掉、滑块跳回红色。
     对外一律输出 CSS 颜色串 —— 完全不透明输出 6 位 hex（与老配置格式一致），
     带透明度才补 8 位 hex，老数据不需要迁移。 */

  /* 收进 0~1。写法上先判 > 0 再 min —— 这样传进来 NaN 时会落到 0，
     不会让 NaN 一路渗进 HSV 把颜色整成 "#NaNNaNNaN"。 */
  const clamp01 = (n) => (n > 0 ? Math.min(n, 1) : 0);

  /* "#abc" / "#aabbcc" / "#aabbccdd" / "rgb(1, 2, 3)" / "rgba(1,2,3,.5)" → {r,g,b,a}
     （a 为 0~1）。认不出来返回 null，由调用方退回兜底色。 */
  const parseColor = (value) => {
    const s = String(value == null ? "" : value).trim().toLowerCase();
    let m = s.match(/^#([0-9a-f]{3,8})$/);
    if (m) {
      let h = m[1];
      if (h.length === 3 || h.length === 4) h = h.replace(/./g, (c) => c + c);
      if (h.length !== 6 && h.length !== 8) return null;
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
    m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[,\s/]+/).filter(Boolean);
      if (p.length < 3) return null;
      const num = (x, max) => {
        const n = parseFloat(x);
        return isNaN(n) ? 0 : Math.max(0, Math.min(max, n));
      };
      return {
        r: Math.round(num(p[0], 255)),
        g: Math.round(num(p[1], 255)),
        b: Math.round(num(p[2], 255)),
        a: p[3] === undefined ? 1 : clamp01(num(p[3], 1)),
      };
    }
    return null;
  };

  const toHex2 = (n) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

  /* 手输的 RGB 分量兜底（超出 0~255 或写了小数都收进来） */
  const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)));

  /* {r,g,b,a} → CSS 颜色串 */
  const rgbaToCss = ({ r, g, b, a }) => {
    const base = "#" + toHex2(r) + toHex2(g) + toHex2(b);
    return a >= 0.999 ? base : base + toHex2(a * 255);
  };

  const rgbToHsv = ({ r, g, b }) => {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const d = max - min;
    let h = 0;
    if (d) {
      if (max === rn) h = ((gn - bn) / d) % 6;
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s: max ? d / max : 0, v: max };
  };

  /* 六段色环，h 可超出 0~360（拖动时不做归一，避免端点跳色） */
  const hueSegment = (c, x, index) =>
    [
      [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
    ][index % 6];

  const hsvToRgb = (h, s, v) => {
    const c = v * s;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const m = v - c;
    const seg = hueSegment(c, x, Math.floor(hp));
    return {
      r: Math.round((seg[0] + m) * 255),
      g: Math.round((seg[1] + m) * 255),
      b: Math.round((seg[2] + m) * 255),
    };
  };

  const rgbToHsl = ({ r, g, b }) => {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const d = max - min;
    const l = (max + min) / 2;
    let h = 0;
    if (d) {
      if (max === rn) h = ((gn - bn) / d) % 6;
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    /* d 为 0 时 s 恒为 0，分母（1 - |2l-1|）在纯黑/纯白处也是 0，靠 d 短路避开除零 */
    return { h, s: d ? d / (1 - Math.abs(2 * l - 1)) : 0, l };
  };

  const hslToRgb = (h, s, l) => {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const m = l - c / 2;
    const seg = hueSegment(c, x, Math.floor(hp));
    return {
      r: Math.round((seg[0] + m) * 255),
      g: Math.round((seg[1] + m) * 255),
      b: Math.round((seg[2] + m) * 255),
    };
  };

  const pad2 = (n) => String(n).padStart(2, "0");

  const formatDateTime = (d = new Date()) =>
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

  const formatDate = (d = new Date()) =>
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  };

  /* YYYYMMDD → YYYY-MM-DD */
  const compactDate = (s) => {
    const m = String(s || "").match(/^(\d{4})(\d{2})(\d{2})$/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
  };

  /* 从文本里提取日期，用于非日记文档（标题里带日期的情况）：
     支持 2026-09-11 / 2026/09/11 / 2026.09.11 / 2026_09_11 / 2026年09月11日 / 20260911。
     提取不到或日期非法时返回空串。 */
  const dateFromText = (raw) => {
    const s = String(raw == null ? "" : raw);
    let m = s.match(/(\d{4})\s*[年./_-]\s*(\d{1,2})\s*[月./_-]\s*(\d{1,2})/);
    if (!m) m = s.match(/(\d{4})(\d{2})(\d{2})(?!\d)/);
    if (!m) return "";
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return "";
    return `${m[1]}-${pad2(mo)}-${pad2(d)}`;
  };

  /* 解析记录行文本；列表项先行去掉行首标记 */
  const parseLine = (raw) => {
    if (!raw) return null;
    const text = String(raw)
      .trim()
      .replace(/^(?:[*+\-]|\d+[.)])\s+/, "");
    const m = text.match(LINE_RE);
    if (!m) return null;
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (hh > 23 || mm > 59) return null;
    const type = m[3].trim();
    const content = m[4].trim();
    if (!type || !content) return null;
    return { hh: pad2(hh), mm: pad2(mm), time: `${pad2(hh)}:${pad2(mm)}`, type, content };
  };

  /* 宽松版解析：只要「时间 类型：」齐了就算类型已经确定，内容可以为空。
     着色用它 —— 类型名敲定的那一刻就能给出正确的颜色；
     等内容也写完才上色的话，中间那段只能先挂一个「未配置类型」的兜底灰，
     等属性落库再变，看起来就是跳一下。落库仍然走严格的 parseLine。 */
  const parseTypePrefix = (raw) => {
    if (!raw) return null;
    const text = String(raw)
      .trim()
      .replace(/^(?:[*+\-]|\d+[.)])\s+/, "");
    const m = text.match(LINE_TYPED_RE);
    if (!m) return null;
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (hh > 23 || mm > 59) return null;
    const type = m[3].trim();
    if (!type) return null;
    return { hh: pad2(hh), mm: pad2(mm), time: `${pad2(hh)}:${pad2(mm)}`, type };
  };

  module.exports = class TimeTrail extends Plugin {
    constructor(options) {
      super(options);
      /* 每个文档一个串行队列，避免属性读写相互穿插 */
      this._serialQueues = new Map();
      /* 文档元信息缓存：id → { date, daily } */
      this._docMeta = new Map();
      this._observers = [];
      this._boundEditors = new WeakSet();
      this._watching = false;
      /* LifeLog Dock 视图状态 */
      this._lifeLogDockEl = null;
      this._lifelogDockCache = null;
      this._lifelogDockCacheTime = 0;
      /* 记录数据变化后的重绘节流句柄（见 _notifyRecordsChanged） */
      this._recordsRefreshTimer = null;
      /* 光标还停在某些行上时挂起的侧栏刷新：等他移开再补（见 _flushPendingRefreshes） */
      this._pendingRefreshParas = new Set();
      /* 等停手后再统一上色 / 落库的段落（见 _watchEditors 里的防抖） */
      this._typingParas = new Set();
      this._onSelectionChange = null;
      this._lifelogDockDateFilter = null;
      /* 日历区默认折叠，保持原有周历条样式；展开后按 _lifelogDockCalAnchor 显示整月 */
      this._lifelogDockCalExpanded = false;
      this._lifelogDockCalAnchor = new Date();
      /* 展开收起的过渡序号，用于丢弃被新一次切换顶掉的收尾回调 */
      this._lifelogDockCalAnimToken = 0;
      this._lifelogDockStatsPeriod = "week";
      this._lifelogDockStatsAnchor = new Date();
      /* 日历标签页当前视图：month = 月历（默认），week / three / day = 时间轴视图。
         四个段位都接上了，清单见模块常量 CAL_TAB_VIEWS。 */
      this._calTabView = "month";
      /* 时间轴视图的「焦点日」：周 / 三日 / 日 都看它所在的那个窗口。
         null 表示还没定过，用的时候按今天算。 */
      this._calTabAnchor = null;
      /* 月视图自己停在的月份（滚动只会改它，不会动焦点日）。null = 跟焦点日走，
         见 _calMonthAnchor()。 */
      this._calTabMonth = null;
      /* 日历标签页的类型筛选：空集合 = 全部类型（默认）。只作用于日历标签页，
         Dock 那套月历不跟着变，否则会出现「月历筛了、下面的列表没筛」的错位。 */
      this._calTabTypeFilter = new Set();
      /* 类型筛选面板是否开着 —— 重绘后据此恢复，否则勾一个就被关掉 */
      this._calTabTypeMenuOpen = false;
      /* 指标段位（指标）：看多长一段（近 N 天，见 METRIC_SCOPES；"0" = 全部）、
         以及用户在卡片上临时切过的尺度（指标名 → day/week/month）。
         都只活在内存里：这是"当下想怎么看"，不是需要长期记住的偏好。 */
      this._calTabMetricScope = METRIC_SCOPE_DEFAULT;
      this._calTabMetricScale = {};
      /* 指标窗口的锚点（窗口的**右端**）：null = 跟今天走（默认）。
         顶栏的翻页挪的就是它 —— 按一次挪一个「查看范围」的步长，
         到了今天就到尽头，再往后按不动；「今天」把它清回 null。 */
      this._calTabMetricAnchor = null;
      /* 指标管理弹窗（挂在 body 上，卸载时要收掉，同类型管理） */
      this._metricModal = null;
      /* 指标改动攒着一起落盘（同 _typesDirty 那套防抖） */
      this._metricsDirty = false;
      this._metricsTimer = null;
      /* 表格视图里被收起的那几天（存日期键）。只活在内存里：
         切月 / 重绘都保留，重启插件回到全展开 —— 折叠是「当下想少看点」，
         不是什么需要长期记住的偏好。 */
      this._calTabTableCollapsed = new Set();
      /* 表格视图工具行（搜索 + 筛选）的状态，同样只活在内存里：
         搜索词（空串 = 没在搜）、时间范围筛选（"" = 全部 /
         "today" / "week" / "month"）、筛选面板开合 —— 重绘后都据此恢复。 */
      this._calTabTableSearch = "";
      this._calTabTableTimeFilter = "";
      this._calTabTableFilterOpen = false;
      /* 习惯「范围」的自绘日历弹层：哪个日期字段开着（"" = 都关着）、
         弹层正在浏览的月份（Date，1 号）—— 重绘后据此恢复。 */
      this._calTabHabitRangePick = "";
      this._calTabHabitRangeView = null;
      /* 上面那套自绘日历当前在改「谁的」范围："" = 顶部那对全局日期，
         否则是习惯名（卡片上的查看窗口设置条共用同一份日历）。 */
      this._calTabHabitRangeScope = "";
      /* 习惯卡上「查看窗口」设置条：开着的那个习惯名（"" = 都关着）。
         就地展开、不做浮层 —— 卡片网格会裁掉溢出的浮层。 */
      this._calTabHabitViewOpen = "";
      /* 搜索输入触发的重绘要把焦点还给输入框（见 _paintCalendarTab），
         这个标记只在该次重绘里有效 */
      this._calTabSearchFocus = false;
      this._calTabSearchTimer = null;
      /* 收起表格筛选面板用的文档级监听（卸载时要摘掉） */
      this._calTabTableFilterDocClick = null;
      /* 收起筛选面板用的文档级监听（卸载时要摘掉） */
      this._calTabTypesDocClick = null;
      /* 「创建的文档」这份数据的缓存；换数据源时整体作废 */
      this._calDocsCache = null;
      this._calDocsCacheTime = 0;
      /* 文档图标 → 颜色 的缓存。取色要读 canvas 像素，同一个图标只算一次；
         连「算不出来」也缓存成空串，免得每次重绘都白跑一遍。 */
      this._calIconColors = new Map();
      /* 正在编辑的那条记录的 id（右键弹出的修改窗持有），空 = 没在编辑 */
      this._calEditId = "";
      this._dockConfigMounted = false;
      /* 有攒下未落盘的类型改动。类型编辑只改内存，关窗或插件卸载时才落盘 ——
         写 petal 文件会被思源侦测到并重载插件，编辑期间写盘会把弹窗直接打断。 */
      this._typesDirty = false;
      /* 挂在 body 上的「设置」弹窗（左侧导航 + 右侧内容），卸载时需手动回收 */
      this._settingsModal = null;
    }

    async onload() {
      this.data = await this.loadData(DATA_KEY).catch(() => ({}));
      if (!this.data || typeof this.data !== "object") this.data = {};
      /* 用户自定义类型分组：只在确实读不到类型表（首次使用）时，用内置默认分组兜底。
         这里刻意不写盘 —— 启动阶段若读到的数据异常为空，写盘会把磁盘上的用户配置
         直接覆盖掉；宁可只在内存里兜底，等用户真正编辑时再落盘。 */
      if (!Array.isArray(this.data.typeGroups) || this.data.typeGroups.length === 0) {
        this.data.typeGroups = DEFAULT_TYPE_GROUPS.map((g) => ({
          name: g.name,
          color: g.color,
          desc: g.desc,
          items: g.items.map((i) => ({ ...i })),
        }));
        console.warn(`${NAME}：没有读到已保存的类型表，本次先按内置默认类型显示`);
      }
      this.data.typeGroups = this.data.typeGroups
        .filter((g) => g && typeof g.name === "string")
        .map((g) => ({
          name: g.name,
          color: typeof g.color === "string" && g.color ? g.color : DEFAULT_TYPE_COLOR,
          desc: typeof g.desc === "string" ? g.desc : "",
          items: (g.items || [])
            .filter((i) => i && typeof i.name === "string" && i.name)
            .map((i) => ({
              name: i.name,
              color: typeof i.color === "string" && i.color ? i.color : (g.color || DEFAULT_TYPE_COLOR),
            })),
        }));
      /* 指标表：没有就是空数组。刻意不给内置兜底 —— 凭空塞几个指标进去，
         用户会以为插件在乱翻他的记录内容；想建的人自己到指标设置里加即可。 */
      this.data.metricGroups = normMetricGroups(this.data.metricGroups);
      /* 旧字段清理：types 已迁移完成，dockEnabled 对应的启用开关也已移除 */
      delete this.data.types;
      delete this.data.dockEnabled;
      /* Dock 栏紧凑模式：默认 false */
      if (typeof this.data.dockCompact !== "boolean") {
        this.data.dockCompact = false;
      }
      /* 块属性名中段：默认 lifelog，用户的输入一律先规范化再落库 */
      this.data.attrPrefix = normAttrPrefix(this.data.attrPrefix);
      /* 记录范围：默认「仅日记」，与旧行为一致；放开档位由用户自行选择 */
      this.data.recordScope = normRecordScope(this.data.recordScope);
      /* 时间计算模式：默认结束模式，只接受候选档位 */
      this.data.timeCalcMode = normTimeMode(this.data.timeCalcMode);
      /* 日历数据源：默认 LifeLog 记录，与旧行为一致；旧配置里没这项时补上 */
      this.data.calendarSource = normCalSource(this.data.calendarSource);
      /* 下划线线宽：默认 0.75px，只接受候选档位 */
      this.data.markLineWidth = normLineWidth(this.data.markLineWidth);
      /* 记录行底色：默认关闭，可选 1% 到 10% */
      this.data.markBgOpacity = normBgOpacity(this.data.markBgOpacity);
      /* Dock 侧边栏显示：默认关闭，用户自行决定是否在思源侧栏显示 LifeLog 面板 */
      this.data.dockVisible = this.data.dockVisible === true;
      /* 生成「块属性 到 --tt-c」的样式映射 */
      this._ensureMarkStyle();

      /* Ctrl+Alt+N：打开（已开着则聚焦到）日历标签页，跟顶栏那枚日历图标同一个入口。
         为什么用命令而不是 Dock 的 hotkey —— Dock 的快捷键语义固定是「开关那个侧栏面板」，
         唤不出主区域的标签页，所以这个键只能走 addCommand；
         面板自己那个键（Ctrl+Alt+O）在下面 addDock 的 config 里。
         原先这里还注册过「打开今日日记」「扫描并打标」，已撤掉；
         对应实现 _openDailyNote / scanAndTag 仍留在类里，需要时再加回来即可。 */
      this.addCommand({
        langKey: "打开轻迹",
        hotkey: TAB_HOTKEY,
        callback: () => this._openCalendarTab(),
      });

      /* 日历标签页：注册 tab 类型。
         Dock 页签栏的「日历」走 _openCalendarTab() → openTab，
         打开后思源会在主区域建一个 tab，渲染交给 _renderCalendarTab。 */
      const plugin = this;
      this.addTab({
        type: CAL_TAB_TYPE,
        init() {
          const tab = this;
          tab.render = (optContainer) =>
            plugin._renderCalendarTab(optContainer || tab.element);
          /* 兜底先渲染一次：个别版本不主动调 render */
          plugin._renderCalendarTab(tab.element);
        },
      });

      /* 侧栏 Dock：1:1 复刻「轻语」LifeLog 侧边栏视图
         （记录 / 统计页签 + 周历筛选 + 时间轴 + 悬浮添加 + 类型选择弹层）。
         注册之前先把存档里的标题 / 快捷键校正过来 —— addDock 一跑，config
         就被存档整份覆盖了，那时候再改就晚了。 */
      this._syncDockMeta();
      this.dock = this.addDock({
        type: DOCK_TYPE,
        config: {
          position: "RightBottom",
          size: { width: 820, height: 0 },
          icon: "iconSpreadEven",
          /* 标题与快捷键都走常量；存档里的旧值由 _syncDockMeta() 在注册前校正，
             否则这里写什么都会被本地存储里的历史配置盖掉。
             这个 hotkey 就是「设置 → 快捷键」里「轻迹」那一行的 Ctrl+Alt+O，
             按下去展开 / 收起本面板；打开标签页的那个键在 onload 的命令里，别搞混。 */
          title: DOCK_TITLE,
          hotkey: DOCK_HOTKEY,
        },
        data: {},
        init: (dock) => this._initLifeLogDock(dock),
        update: () => {
          /* 布局刷新 / Dock 重新显示时按缓存刷新数据 */
          if (this._lifeLogDockEl) this._refreshLifeLogDockContent();
        },
        destroy: () => {
          this._lifeLogDockEl = null;
          this.notebookCddl = null;
          /* 这里不销毁气泡节点 —— 它是全局单例，日历标签页也在用它。
             真正需要清理的时机只有插件卸载（onunload）。 */
        },
      });
    }

    onLayoutReady() {
      this._refreshNotebooks();
      this._watchEditors();

      /* 顶栏图标：日历的入口，与轻语同款 —— **点一下才打开**（已开着则聚焦到它），
         不做启动自动打开：那会把你正在看的文档挤掉、把日历抢到前台。
         图标用思源内置的日历图标，跟标签页自己那枚保持一致。 */
      try {
        this.addTopBar({
          icon: "iconCalendar",
          title: `${NAME}日历`,
          position: "right",
          callback: () => this._openCalendarTab(),
        });
      } catch (e) {
        console.warn(`${NAME}：顶栏按钮注册失败`, e);
      }

      /* Dock 侧边栏显示：默认关闭。
         用户没开开关时，启动时把侧栏的 LifeLog 入口（dock 栏按钮 + 面板）藏起来，
         避免每次重载都多出一个未必用得到的侧栏图标。
         注：addDock 返回的是描述对象（{id,config,model}），没有 show/hide 方法，
         所以这里走 DOM 控制，而不是 this.dock.hide()。 */
      this._applyDockVisibility();
    }

    onunload() {
      this._observers.forEach((obs) => {
        try {
          obs.disconnect();
        } catch (e) {}
      });
      this._observers = [];
      /* 移除动态注入的标记样式 */
      const markStyle = document.getElementById(MARK_STYLE_ID);
      if (markStyle && markStyle.parentNode) {
        markStyle.parentNode.removeChild(markStyle);
      }
      /* 移除下拉的全局外部点击监听 */
      if (this._cddlDocClick) {
        document.removeEventListener("click", this._cddlDocClick);
        this._cddlDocClick = null;
      }
      /* 移除挂在 body 上的悬浮提示气泡 */
      this._destroyDockTooltip();
      /* 关掉还开着的类型管理弹窗：它挂在 body 上，不随插件卸载被回收，
         重载后会留下一个对着废弃实例操作的僵尸窗口 */
      if (this._typesModal) {
        this._typesModal.remove();
        this._typesModal = null;
      }
      /* 指标管理弹窗同理（也挂在 body 上） */
      if (this._metricModal) {
        this._metricModal.remove();
        this._metricModal = null;
      }
      /* 同理回收「设置」弹窗（同样挂在 body 上） */
      if (this._settingsModal) {
        this._settingsModal.remove();
        this._settingsModal = null;
      }
      /* 把攒着没写的类型改动补一次落盘 */
      this._flushTypes();
      /* 指标那笔同样补一次，并清掉还没到点的落盘定时器 */
      if (this._metricsTimer) {
        clearTimeout(this._metricsTimer);
        this._metricsTimer = null;
      }
      this._flushMetrics();
      /* 取消还没到点的重绘，避免卸载后回调再动 DOM */
      if (this._recordsRefreshTimer) {
        clearTimeout(this._recordsRefreshTimer);
        this._recordsRefreshTimer = null;
      }
      /* 摘掉光标监听 */
      if (this._onSelectionChange) {
        document.removeEventListener("selectionchange", this._onSelectionChange);
        this._onSelectionChange = null;
      }
      if (this._pendingRefreshParas) this._pendingRefreshParas.clear();
      if (this._typingParas) this._typingParas.clear();
      /* 摘掉筛选面板的「点外部收起」监听 */
      if (this._calTabTypesDocClick) {
        document.removeEventListener("click", this._calTabTypesDocClick);
        this._calTabTypesDocClick = null;
      }
      /* 摘掉表格筛选面板的「点外部收起」监听，顺手清掉搜索的防抖定时器 */
      if (this._calTabTableFilterDocClick) {
        document.removeEventListener("click", this._calTabTableFilterDocClick);
        this._calTabTableFilterDocClick = null;
      }
      /* 摘掉「范围」自绘日历的「点外部收起」监听 */
      if (this._calTabRangeDocClick) {
        document.removeEventListener("click", this._calTabRangeDocClick);
        this._calTabRangeDocClick = null;
      }
      if (this._calTabSearchTimer) {
        clearTimeout(this._calTabSearchTimer);
        this._calTabSearchTimer = null;
      }
    }

    /* ===================== 请求封装 ===================== */

    /* 统一内核请求：优先 fetchPost（自动带 Token），失败时回落到同源 fetch */
    async _request(url, payload = {}) {
      let resp = null;
      if (typeof fetchPost === "function") {
        try {
          resp = await new Promise((resolve, reject) => {
            fetchPost(url, payload, (data) =>
              data ? resolve(data) : reject(new Error("响应为空"))
            );
          });
        } catch (e) {
          resp = null;
        }
      }
      if (!resp) {
        const raw = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(payload),
        });
        resp = await raw.json();
      }
      if (!resp || resp.code !== 0) {
        throw new Error((resp && resp.msg) || "接口调用失败");
      }
      return resp;
    }

    /* ===================== Dock 渲染 ===================== */

    /* 把设置内容按「分组 + 行」结构渲染进给定的容器元素
       （设置弹窗右侧内容容器；Dock 设置页已移除，仅此一处复用）。 */
    _mountSettingsPanel(container) {
      if (!container) return;
      container.innerHTML = `
        <div class="tt-settings">
          <section class="tt-group">
            <header class="tt-group__title">插入设置</header>
            <div class="tt-group__card" data-tt-group="insert"></div>
          </section>
          <section class="tt-group">
            <header class="tt-group__title">视图外观</header>
            <div class="tt-group__card" data-tt-group="appearance"></div>
          </section>
          <section class="tt-group">
            <header class="tt-group__title">日历设置</header>
            <div class="tt-group__card" data-tt-group="calendar"></div>
          </section>
          <section class="tt-group">
            <header class="tt-group__title">控制设置</header>
            <div class="tt-group__card" data-tt-group="control"></div>
          </section>
          <section class="tt-group">
            <header class="tt-group__title">习惯设置</header>
            <div class="tt-group__card" data-tt-group="habit"></div>
          </section>
          <section class="tt-group">
            <header class="tt-group__title">指标设置</header>
            <div class="tt-group__card" data-tt-group="metric"></div>
          </section>
        </div>
      `;
      const insertCard = container.querySelector('[data-tt-group="insert"]');
      const appearanceCard = container.querySelector('[data-tt-group="appearance"]');
      const calendarCard = container.querySelector('[data-tt-group="calendar"]');
      const controlCard = container.querySelector('[data-tt-group="control"]');
      const habitCard = container.querySelector('[data-tt-group="habit"]');
      const metricCard = container.querySelector('[data-tt-group="metric"]');

      /* —— 插入设置：日记笔记本 —— */
      const notebookRow = this._buildRow({
        title: "日记笔记本",
        desc: "日记位置；「记录范围」选「指定笔记本」时以它为准。",
        controlType: "select",
        placeholder: "请选择笔记本",
        onChange: (v) => {
          this.data.notebook = v;
          this._persist("保存笔记本");
        },
      });
      insertCard.appendChild(notebookRow);
      /* 选项由 _refreshNotebooks 异步填充，这里只留引用 */
      this.notebookCddl = notebookRow.querySelector(".tt-cddl");

      /* —— 插入设置：记录范围 —— */
      const scopeRow = this._buildRow({
        title: "记录范围",
        desc: "哪些文档里的「时间 类型：内容」会被识别。",
        controlType: "select",
        options: RECORD_SCOPE_OPTIONS,
        value: this._recordScope(),
        onChange: (v) => {
          const scope = normRecordScope(v);
          if (this.data.recordScope === scope) return;
          this.data.recordScope = scope;
          this._persist("保存记录范围");
          /* 元信息缓存里带着 box 与日期，范围一变必须整体作废后重扫 */
          this._docMeta.clear();
          this._lifelogDockCache = null;
          this._lifelogDockCacheTime = 0;
          this._rescanOpenEditors();
          this._refreshLifeLogDockContent(true);
          const label =
            (RECORD_SCOPE_OPTIONS.find((o) => o.value === scope) || {}).label ||
            scope;
          showMessage(`${NAME}：记录范围已改为「${label}」`);
        },
      });
      insertCard.appendChild(scopeRow);

      /* —— 视图外观：紧凑模式 —— */
      appearanceCard.appendChild(
        this._buildRow({
          title: "紧凑模式",
          desc: "压缩记录间距，一屏显示更多内容。",
          controlType: "toggle",
          value: !!this.data.dockCompact,
          onChange: (v) => {
            this.data.dockCompact = v;
            this._persist("保存紧凑模式");
            this._applyDockCompact();
          },
        })
      );

      /* —— 日历设置：数据源 —— */
      calendarCard.appendChild(
        this._buildRow({
          title: "日历数据源",
          desc: "日历标签页里展示什么：自己记的 LifeLog 记录，还是思源里创建的文档。",
          controlType: "select",
          options: CAL_SOURCE_OPTIONS,
          value: this._calSource(),
          onChange: (v) => {
            const src = normCalSource(v);
            if (this.data.calendarSource === src) return;
            this.data.calendarSource = src;
            this._persist("保存日历数据源");
            /* 换数据源等于换了一整套数据：文档那份缓存作废后重绘已打开的日历标签页 */
            this._calDocsCache = null;
            this._calDocsCacheTime = 0;
            this._refreshCalendarTabs();
            const label =
              (CAL_SOURCE_OPTIONS.find((o) => o.value === src) || {}).label || src;
            showMessage(`${NAME}：日历数据源已改为「${label}」`);
          },
        })
      );

      /* —— 控制设置：类型管理 —— */
      controlCard.appendChild(
        this._buildRow({
          title: "类型管理",
          desc: "配置记录类型的显示颜色。",
          controlType: "button",
          buttonText: "管理",
          onClick: () => this._openTypesManagerModal(),
        })
      );

      /* —— 控制设置：下划线粗细 —— */
      controlCard.appendChild(
        this._buildRow({
          title: "下划线粗细",
          desc: "记录行底部线条的宽度。",
          controlType: "select",
          options: MARK_LINE_OPTIONS,
          value: String(this._lineWidth()),
          onChange: (v) => {
            this.data.markLineWidth = normLineWidth(v);
            this._persist("保存下划线粗细");
            /* 线宽由注入的样式表控制，改完重建即可即时生效 */
            this._ensureMarkStyle();
          },
        })
      );

      /* —— 控制设置：记录底色 —— */
      controlCard.appendChild(
        this._buildRow({
          title: "记录底色",
          desc: "记录行底色的深浅，默认关闭。",
          controlType: "select",
          options: MARK_BG_OPTIONS,
          value: String(this._bgOpacity()),
          onChange: (v) => {
            this.data.markBgOpacity = normBgOpacity(v);
            this._persist("保存记录底色");
            /* 底色由注入的样式表控制，改完重建即可即时生效 */
            this._ensureMarkStyle();
          },
        })
      );

      /* —— 控制设置：时间计算模式 —— */
      controlCard.appendChild(
        this._buildRow({
          title: "时间计算模式",
          desc:
            "节点时间代表开始还是结束，时间轴、表格与统计都按它算。\n结束模式（默认）算上一条到当前，开始模式算当前到下一条。",
          controlType: "select",
          options: TIME_MODE_OPTIONS,
          value: this._timeCalcMode(),
          onChange: (v) => {
            const mode = normTimeMode(v);
            if (this.data.timeCalcMode === mode) return;
            this.data.timeCalcMode = mode;
            this._persist("保存时间计算模式");
            /* 区间与「持续」在渲染时现算，用缓存里的记录直接重绘即可。
               两个入口都要刷：Dock 时间轴，以及主区域的日历标签页
               （时间轴块 / 表格 / 统计 / 习惯都用同一份口径）。
               Dock 那条路里虽然也顺手刷了日历，但 Dock 没打开时它会直接返回，
               所以这里必须自己再调一次，否则改完设置当场看不到变化。 */
            this._refreshLifeLogDockContent();
            this._refreshCalendarTabs();
            const label =
              (TIME_MODE_OPTIONS.find((o) => o.value === mode) || {}).label || mode;
            showMessage(`${NAME}：时间计算模式已改为「${label}」`);
          },
        })
      );

      /* —— 控制设置：属性名前缀 —— */
      const prefixRow = this._buildRow({
        title: "属性名前缀",
        desc: "两端固定，仅中间一段可改。",
        controlType: "input",
        value: this._attrPfx(),
      });
      controlCard.appendChild(prefixRow);
      const prefixInput = prefixRow.querySelector(".tt-attr__input");
      if (prefixInput) {
        /* 失焦或回车时规范化并落盘 */
        const commitPrefix = () => {
          const pfx = normAttrPrefix(prefixInput.value);
          prefixInput.value = pfx;
          if (this.data.attrPrefix === pfx) return;
          this.data.attrPrefix = pfx;
          this._persist("保存属性名前缀");
          showMessage(`${NAME}：属性名已改为 custom-${pfx}-*，此后新记录生效`);
          /* 前缀变了：重建标记样式，作废缓存并强制重查 */
          this._ensureMarkStyle();
          this._lifelogDockCache = null;
          this._lifelogDockCacheTime = 0;
          this._refreshLifeLogDockContent(true);
        };
        prefixInput.addEventListener("change", commitPrefix);
        prefixInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") prefixInput.blur();
        });
      }

      /* —— 控制设置：Dock 侧边栏显示 —— */
      controlCard.appendChild(
        this._buildRow({
          title: "Dock 侧边栏显示",
          desc: "是否在思源侧栏显示 LifeLog 面板，默认关闭。",
          controlType: "toggle",
          value: !!this.data.dockVisible,
          onChange: (v) => {
            this.data.dockVisible = v;
            this._persist("保存Dock显示");
            /* 即时切换侧栏 Dock 的显隐（走 DOM，不依赖 addDock 返回值） */
            this._applyDockVisibility();
          },
        })
      );

      /* —— 控制设置：时间轴视图的三个显示开关（都默认关闭） ——
         只管周 / 三日 / 日这三个共用结构的视图；月视图条目与当天详情列表不动
         （那边一行里塞不下类型、也没地方放图标）。
         三个都走 _refreshCalendarTabs() 重绘：内容颜色靠容器类切换，
         另外两个直接决定标布里有没有那段 HTML，重绘一次即生效。 */
      controlCard.appendChild(
        this._buildRow({
          title: "内容颜色",
          desc: "时间轴视图里记录的文字按类型色着色；关闭时用主题的正文色与三级文字色。默认关闭。",
          controlType: "toggle",
          value: !!this.data.calTextColor,
          onChange: (v) => {
            this.data.calTextColor = v;
            this._persist("保存内容颜色");
            this._refreshCalendarTabs();
          },
        })
      );

      controlCard.appendChild(
        this._buildRow({
          title: "展示类型",
          desc:
            "时间轴视图（周 / 三日 / 日）的标题写成「类型 | 内容」；关闭时只显示内容。默认关闭。",
          controlType: "toggle",
          value: !!this.data.calShowType,
          onChange: (v) => {
            this.data.calShowType = v;
            this._persist("保存展示类型");
            this._refreshCalendarTabs();
          },
        })
      );

      controlCard.appendChild(
        this._buildRow({
          title: "时间图标",
          desc: "时间前面显示一枚表针图标（思源内置）。默认关闭。",
          controlType: "toggle",
          value: !!this.data.calShowIcon,
          onChange: (v) => {
            this.data.calShowIcon = v;
            this._persist("保存时间图标");
            this._refreshCalendarTabs();
          },
        })
      );

      /* —— 习惯设置：挑哪些类型当习惯（「习惯」页 = 表格旁边的那个段位） ——
         不用再开一层弹窗：候选类型直接铺成芯片，点一下加 / 去，立刻落盘并重绘。
         只有挑中的类型才追踪 —— 「记录」这种量大又杂的类型不会自己挤进来。 */
      habitCard.appendChild(
        this._buildRow({
          title: "习惯类型",
          desc:
            "点一下切换。挑中的类型会在「习惯」段位里一个类型一张卡地追踪，下面还能给每个习惯单独配门槛。",
        })
      );
      /* 习惯分组：把挑中的习惯按模块归类（比如「健康习惯」装喝水、健身），
         习惯页按组分节展示。管理弹窗复用类型管理那套 .tt-modal 骨架。 */
      habitCard.appendChild(
        this._buildRow({
          title: "习惯分组",
          desc: "建几个分组，把挑中的习惯点进对应的组里；习惯页会按分组分节展示。",
          controlType: "button",
          buttonText: "管理",
          onClick: () => this._openHabitGroupModal(),
        })
      );
      const habitPick = document.createElement("div");
      habitPick.className = "tt-habitpick";
      habitCard.appendChild(habitPick);
      this._mountHabitPicker(habitPick);

      /* —— 指标设置：指标段位那份指标表（大类 + 指标）——
         指标是可选模块，默认一张空表，所以这里只给入口和一句现状说明：
         怎么建、怎么改都在「指标管理」弹窗里，不做第二套界面。 */
      if (metricCard) {
        const n = this._metrics().length;
        metricCard.appendChild(
          this._buildRow({
            title: "指标管理",
            desc: n
              ? `已定义 ${n} 个指标。指标从记录内容里抽数值（内容里写了数字，这里就有对应的走势），可按大类与日 / 周 / 月查看。`
              : "指标 = 从记录内容里抽出来的数值。还没建过：点右边的「管理」建一个。",
            controlType: "button",
            buttonText: "管理",
            onClick: () => this._openMetricManagerModal(() => this._refreshCalendarTabs()),
          })
        );
      }

      /* 挂载时拉取笔记本列表（传 container 让刷新落在自己这一份上，
         设置面板在设置弹窗中复用（仅此一处）；各自刷新各自那份，不互相抢 this.notebookCddl） */
      this._refreshNotebooks(container);
    }

    /* 习惯设置的芯片区：把「日历数据里出现过的类型」铺成一行行小芯片，
       点一下加 / 去。改完立刻落盘 + 重绘日历标签页（开着习惯页时不用手动刷新）。
       用 onclick（不是 addEventListener）—— 每点一次都会重排这段 HTML，
       重新赋值监听不会越挂越多。 */
    _mountHabitPicker(host) {
      if (!host) return;
      /* 记下宿主：习惯分组弹窗关掉时要刷新这一份（门槛卡头部的分组小标） */
      this._habitPickHost = host;
      const picked = new Set(this._habitTypes());
      const cands = this._habitCandidates();
      if (!cands.length) {
        host.innerHTML =
          '<div class="tt-habitpick__empty">日历数据里还没出现过类型 —— 先记几条再看。</div>';
        return;
      }
      const chips = cands
        .map(
          (c) =>
            `<button class="tt-habitpick__chip${
              picked.has(c.name) ? " on" : ""
            }" type="button" data-habit-type="${escapeHtml(c.name)}">
                <span class="tt-habitpick__dot" style="background:${escapeHtml(c.color)}"></span>
                <span class="tt-habitpick__name">${escapeHtml(c.name)}</span>
                <span class="tt-habitpick__count">${c.cnt}</span>
            </button>`
        )
        .join("");
      /* 挑中的习惯各配一套目标模型：单位（次数 / 分钟）× 方向（好 / 坏习惯）×
         周期（日 / 周 / 月）× 目标值。等级色由目标值自动推导，不再手填 5 档。 */
      const segHtml = (options, cur, attr) =>
        `<span class="tt-habitpick__units">${options
          .map(
            (o) =>
              `<button class="tt-habitpick__unit${
                cur === o.value ? " on" : ""
              }" type="button" data-habit-${attr}="${o.value}">${o.label}</button>`
          )
          .join("")}</span>`;
      /* YYYY-MM-DD → 「9月1日 周二」：时间范围胶囊上的短标（与习惯页「范围」同款） */
      const dayLabel = (s) => {
        const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) return "";
        const d = new Date(+m[1], +m[2] - 1, +m[3]);
        const wd = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
        return `${d.getMonth() + 1}月${d.getDate()}日 周${wd}`;
      };
      const cfgs = this._habitTypes()
        .map((type) => {
          const cfg = this._habitConfig(type);
          const color = this._colorOf(type) || DEFAULT_TYPE_COLOR;
          const periodWord = HABIT_PERIOD_LABEL[cfg.period];
          /* 目标行前缀：坏习惯用「<」，天数计法固定「≥」 */
          const cmp = cfg.dir === "bad" ? "<" : "≥";
          const goalLabel =
            cfg.period !== "day" && cfg.goalUnit === "days"
              ? `${periodWord} ≥`
              : `${periodWord} ${cmp}`;
          const goalSuffix =
            cfg.period !== "day" && cfg.goalUnit === "days"
              ? "天"
              : cfg.unit === "min"
                ? "分钟"
                : "次";
          /* 时间范围行：胶囊按钮 + 自绘日历弹层 —— 直接复用习惯页「范围」那套
             组件与样式（.north-caltab-habit-range / -rfield / -rcal 是全局类），
             不用原生 date 输入。开合状态存 this._habitDateEdit（{type, which}），
             弹层浏览的月份存 this._habitDateView，重排后不丢。 */
          const dateField = (which, val) => {
            const open =
              this._habitDateEdit &&
              this._habitDateEdit.type === type &&
              this._habitDateEdit.which === which;
            const label = val
              ? dayLabel(val)
              : which === "start"
                ? "开始日期"
                : "结束日期";
            return `<button type="button" class="north-caltab-habit-rfield${
              open ? " open" : ""
            }${val ? "" : " is-empty"}" data-habit-datebtn="${which}">${escapeHtml(
              label
            )}</button>`;
          };
          const dateCal = (which, val) => {
            const open =
              this._habitDateEdit &&
              this._habitDateEdit.type === type &&
              this._habitDateEdit.which === which;
            if (!open) return "";
            const view =
              this._habitDateView instanceof Date
                ? this._habitDateView
                : new Date();
            const y = view.getFullYear();
            const m = view.getMonth();
            const selKey = String(val || "");
            const todayKey = this._calKey(new Date());
            const ws = this._calWeekStart();
            const first = new Date(y, m, 1);
            const lead =
              ws === 1
                ? first.getDay() === 0
                  ? 6
                  : first.getDay() - 1
                : first.getDay();
            const dim = new Date(y, m + 1, 0).getDate();
            const WD = ["日", "一", "二", "三", "四", "五", "六"];
            const weekHead = Array.from(
              { length: 7 },
              (_, i) => `<span>${WD[(ws + i) % 7]}</span>`
            ).join("");
            /* 网格：首行按每周起始日留出上月尾巴，末尾补下月开头 —— 与习惯页同款 */
            const total = Math.ceil((lead + dim) / 7) * 7;
            const start = new Date(y, m, 1 - lead);
            let cells = "";
            for (let i = 0; i < total; i++) {
              const dt = new Date(start);
              dt.setDate(start.getDate() + i);
              const key = this._calKey(dt);
              const cls = [];
              if (dt.getMonth() !== m) cls.push("is-out");
              if (key === todayKey) cls.push("is-today");
              if (key === selKey) cls.push("is-sel");
              cells += `<button type="button" class="${cls.join(
                " "
              )}" data-habit-datepick="${key}">${dt.getDate()}</button>`;
            }
            return `<div class="north-caltab-habit-rcal open">
                    <div class="north-caltab-habit-rcal-head">
                        <button type="button" class="north-caltab-habit-rcal-arrow" data-habit-datenav="prev" data-tip="上个月"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><use xlink:href="#iconLeft"></use></svg></button>
                        <span class="north-caltab-habit-rcal-title">${y}年${m + 1}月</span>
                        <button type="button" class="north-caltab-habit-rcal-arrow" data-habit-datenav="next" data-tip="下个月"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><use xlink:href="#iconRight"></use></svg></button>
                    </div>
                    <div class="north-caltab-habit-rcal-week">${weekHead}</div>
                    <div class="north-caltab-habit-rcal-grid">${cells}</div>
                </div>`;
          };
          const dateRow = `<div class="tt-habitpick__daterow">
                    <span class="tt-habitpick__dlabel">时间范围</span>
                    <span class="north-caltab-habit-range">${dateField(
                      "start",
                      cfg.start
                    )}<span class="north-caltab-habit-range-sep">至</span>${dateField(
            "end",
            cfg.end
          )}${dateCal("start", cfg.start)}${dateCal("end", cfg.end)}</span>${
            cfg.start || cfg.end
              ? `<button type="button" class="tt-habitpick__dclear" data-habit-dclear>不限</button>`
              : `<span class="tt-habitpick__dnote">留空 = 一直都在</span>`
          }
                </div>`;
          return `<div class="tt-habitpick__cfg" data-habit-cfg="${escapeHtml(
            type
          )}" style="--tt-c:${escapeHtml(color)}">
                <div class="tt-habitpick__cfghead">
                    <span class="tt-habitpick__dot" style="background:${escapeHtml(color)}"></span>
                    <span class="tt-habitpick__name">${escapeHtml(type)}</span>${
                      this._habitGroupOf(type)
                        ? `<span class="tt-habitpick__gtag">${escapeHtml(
                            this._habitGroupOf(type)
                          )}</span>`
                        : ""
                    }
                    <span class="tt-habitpick__cfgright">
                        <label class="tt-habitpick__alias"><span>别名</span><input type="text" maxlength="16" value="${escapeHtml(
                          cfg.alias
                        )}" placeholder="${escapeHtml(type)}" data-habit-alias autocomplete="off"></label>
                    </span>
                </div>
                <div class="tt-habitpick__model">
                    ${segHtml(HABIT_UNITS, cfg.unit, "unit")}
                    ${segHtml(HABIT_DIRS, cfg.dir, "dir")}
                    ${segHtml(HABIT_PERIODS, cfg.period, "period")}
                    ${
                      cfg.period === "day"
                        ? ""
                        : segHtml(HABIT_GUNITS, cfg.goalUnit, "gunit")
                    }
                    <label class="tt-habitpick__goalrow">
                        <span>${goalLabel}</span>
                        <input type="number" min="1" max="9999" step="1" value="${cfg.goal}" data-habit-goal autocomplete="off">
                        <span>${goalSuffix}</span>
                    </label>
                    <span class="tt-habitpick__goalrow" data-habit-lv1row>
                        <span>浅档</span>
                        ${segHtml(
                          [
                            { value: "", label: "标准" },
                            { value: "mid", label: "适中" },
                            { value: "deep", label: "较深" },
                          ],
                          cfg.lv1 || "",
                          "lv1"
                        )}
                    </span>
                </div>
                ${dateRow}
            </div>`;
        })
        .join("");
      host.innerHTML =
        `<div class="tt-habitpick__chips">${chips}</div>` +
        (cfgs
          ? `<div class="tt-habitpick__hint">下面给每个习惯配目标模型：好习惯达到目标算达标，坏习惯低于目标算达标（比如「玩手机每天 &lt; 2 小时」）。日目标按天结算；周 / 月目标可选「合计」（整段周期累计达到目标值）或「天数」（周期内达标 N 天）。热力图的 5 级色由目标值自动推导 —— 日目标按目标的倍数，周 / 月目标按周期内累计进度，不用手填档位。「浅档」= 等级 1（打卡量最少那种）的深浅，只影响这个习惯：一天就记一次的习惯选「适中 / 较深」后，年视图里的格子更容易看见。另外，每个习惯想看的时段本来就不一样（打卡看「近 100 天」，另一个只看「本月」）—— 习惯卡名字旁边那枚日期胶囊可以给单个习惯单独设「查看窗口」，互不干扰；没设过的习惯继续跟习惯页顶部那排段位走。</div><div class="tt-habitpick__cfgs">${cfgs}</div>`
          : "");
      /* 用 onclick / onchange 覆盖式绑定：每次重排都重新赋值，监听不会越挂越多 */
      host.onclick = (e) => {
        /* 时间范围：胶囊开合（再点同一个收起）—— 与习惯页「范围」同一套交互。
           打开时让弹层先停在该字段当前日期的那个月（没设就看今天这月）。 */
        const dateBtn = e.target.closest && e.target.closest("[data-habit-datebtn]");
        if (dateBtn) {
          const box = dateBtn.closest("[data-habit-cfg]");
          if (!box) return;
          const type = box.dataset.habitCfg;
          const which = dateBtn.dataset.habitDatebtn === "end" ? "end" : "start";
          const same =
            this._habitDateEdit &&
            this._habitDateEdit.type === type &&
            this._habitDateEdit.which === which;
          if (same) {
            this._habitDateEdit = null;
          } else {
            const cfg = this._habitConfig(type);
            const cur = which === "start" ? cfg.start : cfg.end;
            const m = String(cur || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
            const base = m ? new Date(+m[1], +m[2] - 1, 1) : new Date();
            this._habitDateEdit = { type, which };
            this._habitDateView = new Date(base.getFullYear(), base.getMonth(), 1);
          }
          this._mountHabitPicker(host);
          return;
        }
        /* 日历弹层翻月：只动浏览月份，不改值 */
        const dateNav = e.target.closest && e.target.closest("[data-habit-datenav]");
        if (dateNav) {
          const dir = dateNav.dataset.habitDatenav === "next" ? 1 : -1;
          const view =
            this._habitDateView instanceof Date ? this._habitDateView : new Date();
          this._habitDateView = new Date(
            view.getFullYear(),
            view.getMonth() + dir,
            1
          );
          this._mountHabitPicker(host);
          return;
        }
        /* 选日子：写进对应那一头，弹层收起（与习惯页「选完即收」一致）。
           另一头保持原样，所以先设开始还是先设结束都行；写反了
           _habitSetConfig 会自动对调。 */
        const datePick = e.target.closest && e.target.closest("[data-habit-datepick]");
        if (datePick) {
          const box = datePick.closest("[data-habit-cfg]");
          const edit = this._habitDateEdit;
          if (!box || !edit) return;
          const key = datePick.dataset.habitDatepick || "";
          if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
            const type = box.dataset.habitCfg;
            const cfg = this._habitConfig(type);
            if (edit.which === "end") cfg.end = key;
            else cfg.start = key;
            this._habitSetConfig(type, cfg);
            this._refreshCalendarTabs();
          }
          this._habitDateEdit = null;
          this._mountHabitPicker(host);
          return;
        }
        /* 「不限」：清掉时间范围，回到一直都在 */
        const dclear = e.target.closest && e.target.closest("[data-habit-dclear]");
        if (dclear) {
          const box = dclear.closest("[data-habit-cfg]");
          if (!box) return;
          const type = box.dataset.habitCfg;
          const cfg = this._habitConfig(type);
          cfg.start = "";
          cfg.end = "";
          this._habitSetConfig(type, cfg);
          this._mountHabitPicker(host);
          this._refreshCalendarTabs();
          return;
        }
        /* 五段切换（单位 / 方向 / 周期 / 计法 / 浅档）共用一套逻辑 */
        const ATTRS = ["unit", "dir", "period", "gunit", "lv1"];
        for (const attr of ATTRS) {
          const btn = e.target.closest && e.target.closest(`[data-habit-${attr}]`);
          if (!btn) continue;
          const box = btn.closest("[data-habit-cfg]");
          if (!box) return;
          const type = box.dataset.habitCfg;
          const cfg = this._habitConfig(type);
          const v = btn.dataset[`habit${attr[0].toUpperCase()}${attr.slice(1)}`];
          const key = attr === "gunit" ? "goalUnit" : attr;
          if (cfg[key] === v) return;
          cfg[key] = v;
          if (key === "unit") {
            /* 换了量纲，目标值换成该单位的默认（次数 1 次 ↔ 分钟 30 分） */
            cfg.goal = HABIT_GOAL_DEFAULT[cfg.unit];
          }
          if (key === "period") {
            /* 日目标没有「合计 / 天数」之分，切回日目标时计法归位 */
            if (v === "day") cfg.goalUnit = "value";
          }
          this._habitSetConfig(type, cfg);
          this._mountHabitPicker(host);
          this._refreshCalendarTabs();
          return;
        }
        const chip = e.target.closest && e.target.closest("[data-habit-type]");
        if (!chip) {
          /* 点在空白处：收起可能还开着的日历弹层（别让浮层一直挂着） */
          if (this._habitDateEdit) {
            this._habitDateEdit = null;
            this._mountHabitPicker(host);
          }
          return;
        }
        const name = chip.dataset.habitType;
        /* 以当前设置为基础改，不依赖 DOM 顺序；Set 保序 → 习惯卡的先后＝点选先后 */
        const next = new Set(this._habitTypes());
        if (next.has(name)) next.delete(name);
        else next.add(name);
        this.data.habitTypes = Array.from(next);
        this._persist("保存习惯类型");
        this._mountHabitPicker(host);
        this._refreshCalendarTabs();
      };
      /* 文本类输入用 change（失焦 / 回车）触发：免得每敲一个字就重绘一次日历。
         别名与门槛输入都走这里。 */
      host.onchange = (e) => {
        const aliasInput =
          e.target.closest && e.target.closest("[data-habit-alias]");
        if (aliasInput) {
          const box = aliasInput.closest("[data-habit-cfg]");
          if (!box) return;
          const type = box.dataset.habitCfg;
          const cfg = this._habitConfig(type);
          cfg.alias = String(aliasInput.value == null ? "" : aliasInput.value).trim();
          this._habitSetConfig(type, cfg);
          aliasInput.value = cfg.alias;
          this._refreshCalendarTabs();
          return;
        }
        const input = e.target.closest && e.target.closest("[data-habit-goal]");
        if (!input) return;
        const box = input.closest("[data-habit-cfg]");
        if (!box) return;
        const type = box.dataset.habitCfg;
        const cfg = this._habitConfig(type);
        const raw = String(input.value == null ? "" : input.value).trim();
        const v = Math.max(1, Math.min(99999, parseFloat(raw) || 1));
        cfg.goal = v;
        this._habitSetConfig(type, cfg);
        input.value = v;
        this._refreshCalendarTabs();
      };
    }

    /* ===================== 设置面板通用组件 ===================== */

    /* 构造一行：左列（标题 + 描述） + 右列（控件：select / toggle / button / input）
       select 需传 options（[{ value, label }]），可再传 placeholder 与 onChange。 */
    _buildRow({
      title,
      desc,
      controlType,
      value,
      onChange,
      onClick,
      buttonText,
      options,
      placeholder,
    }) {
      const row = document.createElement("div");
      row.className = "tt-row";

      const left = document.createElement("div");
      left.className = "tt-row__left";
      const titleEl = document.createElement("div");
      titleEl.className = "tt-row__title";
      titleEl.textContent = title;
      const descEl = document.createElement("div");
      descEl.className = "tt-row__desc";
      descEl.textContent = desc;
      left.appendChild(titleEl);
      left.appendChild(descEl);
      row.appendChild(left);

      const right = document.createElement("div");
      right.className = "tt-row__right";

      if (controlType === "select") {
        /* 轻语同款自定义下拉（cddl）：触发按钮 + 弹出层，避免原生 select 的浏览器外观 */
        right.appendChild(
          this._buildCddl({ options, value, placeholder, onChange })
        );
      } else if (controlType === "toggle") {
        right.appendChild(this._buildToggle(!!value, onChange));
      } else if (controlType === "button") {
        const btn = document.createElement("button");
        btn.className = "tt-row__button";
        btn.type = "button";
        btn.textContent = buttonText || "管理";
        if (typeof onClick === "function") {
          btn.addEventListener("click", onClick);
        }
        right.appendChild(btn);
      } else if (controlType === "input") {
        /* 前后固定文字夹一个输入框，直观表达「只有中段可以改」 */
        const attr = document.createElement("div");
        attr.className = "tt-attr";
        const pre = document.createElement("span");
        pre.className = "tt-attr__fix";
        pre.textContent = "custom-";
        const input = document.createElement("input");
        input.className = "tt-attr__input";
        input.type = "text";
        input.spellcheck = false;
        input.setAttribute("autocomplete", "off");
        input.maxLength = 24;
        input.placeholder = DEFAULT_ATTR_PREFIX;
        input.value = value == null ? "" : String(value);
        const post = document.createElement("span");
        post.className = "tt-attr__fix";
        post.textContent = "-content";
        attr.appendChild(pre);
        attr.appendChild(input);
        attr.appendChild(post);
        right.appendChild(attr);
      }

      row.appendChild(right);
      return row;
    }

    /* 构造一个自定义下拉（cddl）并绑定交互：开合、选中、外部点击收起。
       options 为 [{ value, label }]；列表为空时弹出层留给调用方异步填充（如笔记本列表）。
       选中后调用 onChange(值)，同时把显示文案与选中态就地更新。 */
    _buildCddl({ options, value, placeholder, onChange }) {
      const list = Array.isArray(options) ? options : [];
      const cddl = document.createElement("div");
      cddl.className = "tt-cddl";
      cddl.innerHTML = `
        <button type="button" class="tt-cddl__trigger">
          <span class="tt-cddl__value"></span>
          <svg class="tt-cddl__arrow" width="10" height="10" viewBox="0 0 10 10"><path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="tt-cddl__popup"></div>
      `;
      const trigger = cddl.querySelector(".tt-cddl__trigger");
      const popup = cddl.querySelector(".tt-cddl__popup");
      const valueEl = cddl.querySelector(".tt-cddl__value");
      const fallback = placeholder || "请选择";

      cddl.dataset.value = value == null ? "" : String(value);
      const current = cddl.dataset.value;
      const hit = list.find((o) => String(o.value) === current);
      valueEl.textContent = hit ? hit.label : fallback;
      if (list.length) {
        popup.innerHTML = list
          .map(
            (o) =>
              `<div class="tt-cddl__item${
                String(o.value) === current ? " active" : ""
              }" data-value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</div>`
          )
          .join("");
      }

      /* 触发：开/关弹出层；向下空间不足时改为向上展开（与轻语一致） */
      trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        const willOpen = !cddl.classList.contains("open");
        cddl.classList.toggle("open", willOpen);
        if (willOpen) {
          const r = trigger.getBoundingClientRect();
          const ph = popup.scrollHeight || 220;
          cddl.classList.toggle(
            "drop-up",
            r.bottom + ph > window.innerHeight - 8
          );
        }
      });

      /* 选择某一项：更新值、文案与选中态，然后收起 */
      popup.addEventListener("click", (e) => {
        const item = e.target.closest(".tt-cddl__item");
        if (!item) return;
        cddl.dataset.value = item.dataset.value || "";
        valueEl.textContent = item.textContent || fallback;
        popup
          .querySelectorAll(".tt-cddl__item")
          .forEach((i) => i.classList.toggle("active", i === item));
        cddl.classList.remove("open");
        if (typeof onChange === "function") onChange(cddl.dataset.value);
      });

      this._bindCddlDocClick();
      return cddl;
    }

    /* 全局共用一份外部点击监听：收起页面上所有打开的下拉 */
    _bindCddlDocClick() {
      if (this._cddlDocClick) return;
      this._cddlDocClick = (e) => {
        document.querySelectorAll(".tt-cddl.open").forEach((el) => {
          if (!el.contains(e.target)) el.classList.remove("open");
        });
      };
      document.addEventListener("click", this._cddlDocClick);
    }

    /* ===================== 取色面板 =====================
       给一个色块按钮装上取色面板：HSV 面板 + 色相条 + 透明度条，
       输入区支持 Hex / RGB / HSL 三种模式（默认 Hex），下方是「最近使用颜色」
       与「系统预设颜色」。

       面板不是就地插进文档，而是挂到 document.body 上 fixed 定位 ——
       设置弹窗与类型管理弹窗都带 overflow:hidden，留在原地会被裁掉。

       改色回抛策略：拖动过程中约 90ms 节流一次（onChange），松手立刻补一次并
       记入「最近使用」——拖动时每帧都回抛的话，外部要重建标记样式与 Dock，
       60fps 下会明显掉帧。 */
    _initColorPicker(trigger, opts) {
      const options = opts || {};
      const initial = parseColor(options.color) || parseColor(DEFAULT_TYPE_COLOR);

      trigger.classList.add("tt-cpicker-trigger");
      trigger.type = "button";
      trigger.innerHTML = '<span class="tt-cpicker-swatch"><i></i></span>';
      const triggerFill = trigger.querySelector(".tt-cpicker-swatch > i");

      /* 面板打开期间改的是 work（副本），没提交就关掉不留痕 */
      let work = Object.assign({}, rgbToHsv(initial), { a: initial.a });
      let mode = "hex";
      let panel = null;
      let emitTimer = 0;
      let lastEmit = 0;
      /* 面板打开期间挂在全局的三个监听，close 时按引用摘掉 */
      let hDocDown = null;
      let hKeyDown = null;
      let hViewport = null;

      const rgbaOf = (d) => {
        const c = hsvToRgb(d.h, d.s, d.v);
        return { r: c.r, g: c.g, b: c.b, a: d.a };
      };
      const cssOf = (d) => rgbaToCss(rgbaOf(d));

      /* 没开面板时也要把当前颜色画在触发按钮上 */
      const paintTrigger = () => {
        triggerFill.style.background = cssOf(work);
        trigger.dataset.color = cssOf(work);
      };
      paintTrigger();

      const setColor = (value) => {
        const rgba = parseColor(value);
        if (!rgba) return;
        const hsv = rgbToHsv(rgba);
        work = { h: hsv.h, s: hsv.s, v: hsv.v, a: rgba.a };
        paintTrigger();
      };

      const open = () => {
        if (panel) return;
        /* 每次打开都从触发按钮上的当前色重建编辑态 */
        setColor(trigger.dataset.color || options.color);

        const el = document.createElement("div");
        el.className = "tt-cpicker";
        el.style.zIndex = String(CPICKER_Z);
        el.innerHTML = `
          <div class="tt-cpicker__sv"><span class="tt-cpicker__sv-dot"></span></div>
          <div class="tt-cpicker__colors">
            <div class="tt-cpicker__bars">
              <div class="tt-cpicker__bar tt-cpicker__hue"><span class="tt-cpicker__dot"></span></div>
              <div class="tt-cpicker__bar tt-cpicker__alpha"><span class="tt-cpicker__dot"></span></div>
            </div>
            <div class="tt-cpicker__preview"><i></i></div>
          </div>
          <div class="tt-cpicker__fields">
            <button type="button" class="tt-cpicker__mode"><span class="tt-cpicker__mode-text">Hex</span><svg viewBox="0 0 10 10" width="10" height="10"><path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            <div class="tt-cpicker__modes"></div>
            <div class="tt-cpicker__input"></div>
          </div>
          <div class="tt-cpicker__section">
            <div class="tt-cpicker__label">最近使用颜色</div>
            <div class="tt-cpicker__grid tt-cpicker__recent"></div>
          </div>
          <div class="tt-cpicker__section">
            <div class="tt-cpicker__label">系统预设颜色</div>
            <div class="tt-cpicker__grid tt-cpicker__presets"></div>
          </div>
        `;
        panel = el;

        const sv = el.querySelector(".tt-cpicker__sv");
        const svDot = el.querySelector(".tt-cpicker__sv-dot");
        const hue = el.querySelector(".tt-cpicker__hue");
        const hueDot = hue.querySelector(".tt-cpicker__dot");
        const alphaBar = el.querySelector(".tt-cpicker__alpha");
        const alphaDot = alphaBar.querySelector(".tt-cpicker__dot");
        const previewFill = el.querySelector(".tt-cpicker__preview > i");
        const modeBtn = el.querySelector(".tt-cpicker__mode");
        const modeText = el.querySelector(".tt-cpicker__mode-text");
        const modesEl = el.querySelector(".tt-cpicker__modes");
        const inputEl = el.querySelector(".tt-cpicker__input");
        const recentEl = el.querySelector(".tt-cpicker__recent");
        const presetsEl = el.querySelector(".tt-cpicker__presets");
        /* 数值输入框：Hex 一个、RGB / HSL 三个，随模式重建；透明度那一格也在同一个框内 */
        let inputs = [];
        let alphaEl = null;

        modesEl.innerHTML = [
          ["hex", "Hex"],
          ["rgb", "RGB"],
          ["hsl", "HSL"],
        ]
          .map(
            ([v, t]) =>
              `<div class="tt-cpicker__mode-item" data-mode="${v}">${t}</div>`
          )
          .join("");

        /* 每一格该显示什么：Hex 只有一格（不含 # —— # 是框内静态前缀）*/
        const valueOf = (idx) => {
          const rgb = rgbaOf(work);
          if (mode === "rgb") return String([rgb.r, rgb.g, rgb.b][idx]);
          if (mode === "hsl") {
            const hsl = rgbToHsl(rgb);
            return [
              String(Math.round(hsl.h)),
              Math.round(hsl.s * 100) + "%",
              Math.round(hsl.l * 100) + "%",
            ][idx];
          }
          return rgbaToCss({ r: rgb.r, g: rgb.g, b: rgb.b, a: 1 }).slice(1);
        };

        const applyRgb = (rgb) => {
          const hsv = rgbToHsv(rgb);
          work.h = hsv.h;
          work.s = hsv.s;
          work.v = hsv.v;
          render();
          emit(false);
        };

        /* 数值栏改动：按当前模式把格子里内容合回颜色。
           只改色相 / 饱和度 / 明度 —— 透明度是独立的一维，
           唯独 Hex 里显式写了 4 / 8 位时才连透明度一起改。 */
        const onValueInput = () => {
          if (mode === "hex") {
            const digits = String(inputs[0].value).trim().replace(/^#+/, "");
            const parsed = parseColor("#" + digits);
            if (!parsed) return;
            if (digits.length === 4 || digits.length === 8) work.a = parsed.a;
            applyRgb(parsed);
            return;
          }
          const nums = inputs.map((input) =>
            parseFloat(String(input.value).replace(/[^\d.]/g, ""))
          );
          if (nums.some((n) => isNaN(n))) return;
          applyRgb(
            mode === "rgb"
              ? { r: clamp255(nums[0]), g: clamp255(nums[1]), b: clamp255(nums[2]) }
              : hslToRgb(nums[0], clamp01(nums[1] / 100), clamp01(nums[2] / 100))
          );
        };

        /* 按模式重建数值输入框。整行是「一个框、里面几格」：
             · Hex：# 是框内的静态前缀（不可选中，复制只拿到后面的值）+ 一格数值；
             · RGB / HSL：三格等宽数值；
             · 末尾一刀分隔线之后是透明度那一格，再跟一个 % —— 都在同一个框里。 */
        const buildInputs = () => {
          inputEl.innerHTML = "";
          inputs = [];
          alphaEl = null;
          if (mode === "hex") {
            const prefix = document.createElement("span");
            prefix.className = "tt-cpicker__prefix";
            prefix.textContent = "#";
            inputEl.appendChild(prefix);
          }
          const count = mode === "hex" ? 1 : 3;
          for (let i = 0; i < count; i++) {
            if (i) {
              const sep = document.createElement("span");
              sep.className = "tt-cpicker__sep";
              inputEl.appendChild(sep);
            }
            const input = document.createElement("input");
            input.type = "text";
            input.className = "tt-cpicker__cell";
            input.spellcheck = false;
            input.autocomplete = "off";
            input.addEventListener("input", onValueInput);
            input.addEventListener("keydown", (e) => {
              if (e.key === "Enter") input.blur();
            });
            input.addEventListener("blur", () => {
              render();
              commit();
            });
            inputEl.appendChild(input);
            inputs.push(input);
          }

          const bar = document.createElement("span");
          bar.className = "tt-cpicker__sep";
          inputEl.appendChild(bar);

          alphaEl = document.createElement("input");
          alphaEl.type = "text";
          alphaEl.className = "tt-cpicker__alpha-value";
          alphaEl.spellcheck = false;
          alphaEl.autocomplete = "off";
          alphaEl.inputMode = "numeric";
          alphaEl.addEventListener("input", () => {
            applyAlpha();
            render();
            emit(false);
          });
          alphaEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") alphaEl.blur();
          });
          alphaEl.addEventListener("blur", () => {
            applyAlpha();
            render();
            commit();
          });
          inputEl.appendChild(alphaEl);

          const unit = document.createElement("span");
          unit.className = "tt-cpicker__unit";
          unit.textContent = "%";
          inputEl.appendChild(unit);
        };

        /* 把 work 铺到面板上。正在编辑的输入框跳过 —— 否则打到一半就被改写，
           光标还会跳到最后 */
        const render = () => {
          const rgb = rgbaOf(work);
          const css = rgbaToCss(rgb);
          sv.style.setProperty("--tt-cpicker-hue", `hsl(${work.h}, 100%, 50%)`);
          svDot.style.left = work.s * 100 + "%";
          svDot.style.top = (1 - work.v) * 100 + "%";
          hueDot.style.left = (work.h / 360) * 100 + "%";
          alphaBar.style.setProperty(
            "--tt-cpicker-alpha",
            `hsl(${work.h}, 100%, 50%)`
          );
          alphaDot.style.left = work.a * 100 + "%";
          previewFill.style.background = css;
          triggerFill.style.background = css;
          trigger.dataset.color = css;
          inputs.forEach((input, i) => {
            if (document.activeElement !== input) input.value = valueOf(i);
          });
          if (alphaEl && document.activeElement !== alphaEl) {
            alphaEl.value = String(Math.round(work.a * 100));
          }
        };

        /* 色块行：色块底是棋盘格（透明色也能看出来），填色层用颜色本身 */
        const paintChips = (container, colors, emptyText) => {
          container.innerHTML = "";
          if (!colors.length) {
            container.innerHTML = `<span class="tt-cpicker__empty">${emptyText}</span>`;
            return;
          }
          colors.forEach((c) => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "tt-cpicker__chip";
            chip.title = c;
            chip.innerHTML = `<i style="background:${escapeHtml(c)}"></i>`;
            chip.addEventListener("click", () => {
              /* 走 commit：点了预设就算「用过这个颜色」，要进最近使用 */
              setColor(c);
              render();
              commit();
            });
            container.appendChild(chip);
          });
        };

        const renderRecent = () => {
          paintChips(recentEl, (this.data && this.data.recentColors) || [], "暂无");
        };

        /* 回抛节流：拖动中每 90ms 一次，其余场合强制立即发出 */
        const emit = (force) => {
          if (typeof options.onChange !== "function") return;
          const now = Date.now();
          if (!force && now - lastEmit < 90) {
            if (!emitTimer) {
              emitTimer = window.setTimeout(() => {
                emitTimer = 0;
                lastEmit = Date.now();
                options.onChange(cssOf(work));
              }, 90);
            }
            return;
          }
          lastEmit = now;
          options.onChange(cssOf(work));
        };

        /* 一次改色的收尾：入「最近使用」+ 确保最终值回抛 */
        const commit = () => {
          if (emitTimer) {
            clearTimeout(emitTimer);
            emitTimer = 0;
          }
          this._pushRecentColor(cssOf(work));
          renderRecent();
          emit(true);
        };

        /* 按住拖动改值：SV 面板给两轴，色相 / 透明度条只用横轴 */
        const bindDrag = (target, onPick) => {
          const pick = (e) => {
            const r = target.getBoundingClientRect();
            onPick(
              clamp01((e.clientX - r.left) / (r.width || 1)),
              clamp01((e.clientY - r.top) / (r.height || 1))
            );
          };
          target.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            try {
              target.setPointerCapture(e.pointerId);
            } catch (err) {}
            const move = (ev) => {
              pick(ev);
              render();
              emit(false);
            };
            move(e);
            const up = () => {
              target.removeEventListener("pointermove", move);
              target.removeEventListener("pointerup", up);
              target.removeEventListener("pointercancel", up);
              render();
              commit();
            };
            target.addEventListener("pointermove", move);
            target.addEventListener("pointerup", up);
            target.addEventListener("pointercancel", up);
          });
        };

        bindDrag(sv, (x, y) => {
          work.s = x;
          work.v = 1 - y;
        });
        bindDrag(hue, (x) => {
          work.h = x * 360;
        });
        bindDrag(alphaBar, (x) => {
          work.a = x;
        });

        /* 透明度输入框：填 0~100 的百分数（框里末尾带 % 单位）。
           监听在 buildInputs 里随格子一起挂 —— 那格是重建出来的。 */
        const applyAlpha = () => {
          const n = parseFloat(String(alphaEl.value).replace(/[^\d.]/g, ""));
          work.a = isNaN(n) ? 1 : clamp01(n / 100);
        };

        /* 模式切换：默认 Hex。换模式即换一套输入控件（1 格 / 3 格），
           所以要重建后再刷一遍数值 */
        const setMode = (m) => {
          mode = m === "rgb" || m === "hsl" ? m : "hex";
          modeText.textContent =
            mode === "rgb" ? "RGB" : mode === "hsl" ? "HSL" : "Hex";
          modesEl.classList.remove("open");
          modeBtn.classList.remove("open");
          modesEl.querySelectorAll(".tt-cpicker__mode-item").forEach((i) => {
            i.classList.toggle("active", i.getAttribute("data-mode") === mode);
          });
          buildInputs();
          render();
        };
        modeBtn.addEventListener("click", () => {
          const willOpen = !modesEl.classList.contains("open");
          modesEl.classList.toggle("open", willOpen);
          /* 按钮上的箭头跟着翻（过渡写在 CSS 里） */
          modeBtn.classList.toggle("open", willOpen);
        });
        modesEl.addEventListener("click", (e) => {
          const item = e.target.closest("[data-mode]");
          if (item) setMode(item.getAttribute("data-mode"));
        });
        /* 点面板里别处就收起模式菜单（面板整体靠外点关闭，菜单没必要跟着一起收） */
        el.addEventListener("pointerdown", (e) => {
          if (e.target.closest(".tt-cpicker__mode")) return;
          if (e.target.closest(".tt-cpicker__modes")) return;
          modesEl.classList.remove("open");
          modeBtn.classList.remove("open");
        });

        document.body.appendChild(el);

        const place = () => {
          const r = trigger.getBoundingClientRect();
          const w = el.offsetWidth;
          const h = el.offsetHeight;
          const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
          let top = r.bottom + 6;
          if (top + h > window.innerHeight - 8) {
            const up = r.top - h - 6;
            top = up >= 8 ? up : Math.max(8, window.innerHeight - h - 8);
          }
          el.style.left = left + "px";
          el.style.top = top + "px";
        };

        hDocDown = (e) => {
          if (panel.contains(e.target) || trigger.contains(e.target)) return;
          close();
        };
        /* ESC 只收面板，不往下传 —— 否则这一下会顺手把设置弹窗一起关掉。
           挂在 window 的捕获阶段，比两个弹窗注册在 document 上的监听更早拿到事件。 */
        hKeyDown = (e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          e.preventDefault();
          close();
        };
        /* 弹窗内滚动 / 改窗口大小后，面板的 fixed 坐标就对不上色块了，直接收起 */
        hViewport = () => close();

        window.addEventListener("keydown", hKeyDown, true);
        document.addEventListener("pointerdown", hDocDown, true);
        window.addEventListener("scroll", hViewport, true);
        window.addEventListener("resize", hViewport);

        setMode("hex");
        render();
        renderRecent();
        paintChips(presetsEl, COLOR_PRESETS, "");
        place();
        trigger.classList.add("open");
      };

      const close = () => {
        if (!panel) return;
        /* 输入框还聚焦着就先让它失焦 —— blur 会走 commit，
           否则「刚打完颜色就直接点别处」这一笔会被关面板吞掉 */
        const active = document.activeElement;
        if (active && panel.contains(active) && typeof active.blur === "function") {
          active.blur();
        }
        /* 拖动中攒着的那一次回抛也不能丢 */
        if (emitTimer) {
          clearTimeout(emitTimer);
          emitTimer = 0;
          if (typeof options.onChange === "function") options.onChange(cssOf(work));
        }
        window.removeEventListener("keydown", hKeyDown, true);
        document.removeEventListener("pointerdown", hDocDown, true);
        window.removeEventListener("scroll", hViewport, true);
        window.removeEventListener("resize", hViewport);
        panel.remove();
        panel = null;
        hDocDown = null;
        hKeyDown = null;
        hViewport = null;
        trigger.classList.remove("open");
        if (this._closeColorPicker === close) this._closeColorPicker = null;
      };

      trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        if (panel) {
          close();
          return;
        }
        /* 这个色块可能只是「显示」用的（指标绑了类型时就是这样，颜色由类型决定），
           要不要弹面板交给调用方定 —— 返回 false 就当按了一下，什么也不开 */
        if (typeof options.canOpen === "function" && options.canOpen(trigger) === false) return;
        /* 同时只留一个面板 */
        if (typeof this._closeColorPicker === "function") this._closeColorPicker();
        open();
        this._closeColorPicker = close;
      });

      return { setColor };
    }

    /* 记一笔「最近使用颜色」：最多 RECENT_COLOR_MAX 条，重复的挪到最前。
       只改内存并标脏（与 _saveTypes 同策略），落盘统一等关窗 / 卸载。 */
    _pushRecentColor(color) {
      const rgba = parseColor(color);
      if (!rgba || !this.data) return;
      /* 统一成规范写法（小写、不透明只留 6 位），免得同一个色以两种形式重复占位 */
      const key = rgbaToCss(rgba);
      const list = (this.data.recentColors || []).filter(
        (c) => String(c).toLowerCase() !== key.toLowerCase()
      );
      list.unshift(key);
      this.data.recentColors = list.slice(0, RECENT_COLOR_MAX);
      this._typesDirty = true;
    }

    /* 构造一个开关（label + checkbox + 滑块 span） */
    _buildToggle(value, onChange) {
      const label = document.createElement("label");
      label.className = "tt-toggle";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "tt-toggle__input";
      input.checked = value;
      const slider = document.createElement("span");
      slider.className = "tt-toggle__slider";
      label.appendChild(input);
      label.appendChild(slider);
      if (typeof onChange === "function") {
        input.addEventListener("change", () => onChange(input.checked));
      }
      return label;
    }

    /* 打开「类型管理」弹窗，复用 _buildTypeSettings() 内容；支持拖拽移动 */
    _openTypesManagerModal(onClose) {
      /* 同时只允许一个实例 */
      if (this._typesModal) {
        this._typesModal.remove();
        this._typesModal = null;
      }
      const modal = document.createElement("div");
      modal.className = "tt-modal";
      modal.innerHTML = `
        <div class="tt-modal__backdrop"></div>
        <div class="tt-modal__panel">
          <div class="tt-modal__header">
            <span class="tt-modal__header-title">类型管理</span>
            <button class="tt-modal__close" type="button" aria-label="关闭">×</button>
          </div>
          <div class="tt-modal__body"></div>
        </div>
      `;
      const body = modal.querySelector(".tt-modal__body");
      body.appendChild(this._buildTypeSettings());

      const panel = modal.querySelector(".tt-modal__panel");
      const header = modal.querySelector(".tt-modal__header");

      /* 拖拽移动：在标题栏按住拖动；面板改用 fixed 定位以记录偏移量 */
      let dragging = false;
      let startX = 0, startY = 0, baseLeft = 0, baseTop = 0;

      const ensurePositioned = () => {
        if (panel.style.position === "fixed") return;
        const r = panel.getBoundingClientRect();
        panel.style.position = "fixed";
        panel.style.margin = "0";
        panel.style.left = r.left + "px";
        panel.style.top = r.top + "px";
      };

      const onMove = (e) => {
        if (!dragging) return;
        let nx = baseLeft + (e.clientX - startX);
        let ny = baseTop + (e.clientY - startY);
        const w = panel.offsetWidth;
        const h = panel.offsetHeight;
        nx = Math.max(8, Math.min(nx, window.innerWidth - w - 8));
        ny = Math.max(8, Math.min(ny, window.innerHeight - h - 8));
        panel.style.left = nx + "px";
        panel.style.top = ny + "px";
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        header.classList.remove("tt-modal__header--dragging");
        document.body.style.userSelect = "";
      };

      header.addEventListener("mousedown", (e) => {
        /* 点到关闭按钮时不触发拖拽 */
        if (e.target.closest(".tt-modal__close")) return;
        ensurePositioned();
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        baseLeft = panel.getBoundingClientRect().left;
        baseTop = panel.getBoundingClientRect().top;
        header.classList.add("tt-modal__header--dragging");
        document.body.style.userSelect = "none";
        e.preventDefault();
      });
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);

      const close = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.removeEventListener("keydown", onKey, true);
        /* 取色面板挂在 body 上，不随弹窗一起销毁，得手动收掉 */
        if (typeof this._closeColorPicker === "function") this._closeColorPicker();
        modal.remove();
        if (this._typesModal === modal) this._typesModal = null;
        /* 关窗前把攒着的改动落盘，免得防抖还没到点就被关掉 */
        this._flushTypes();
        /* 关窗后通知调用方（例如日历标签页需要重绘以反映类型 / 颜色的变动） */
        if (typeof onClose === "function") {
          try {
            onClose();
          } catch (e) {
            console.warn(`${NAME}：类型管理关闭回调失败`, e);
          }
        }
      };

      /* ESC 关闭 */
      const onKey = (e) => {
        if (e.key === "Escape") close();
      };
      document.addEventListener("keydown", onKey, true);

      modal.querySelector(".tt-modal__backdrop").addEventListener("click", close);
      modal.querySelector(".tt-modal__close").addEventListener("click", close);

      document.body.appendChild(modal);
      /* 打开即接管为 fixed 定位，避免首次拖动时跳一下 */
      ensurePositioned();
      this._typesModal = modal;
    }

    /* ===================== 指标（从记录内容里抽数值画折线） =====================
       读写规则一句话：**只读记录，只写设置**。
         · 读：记录（date / content）+ 设置里的指标表，全是纯函数，好做单测；
         · 写：只写 data.metricGroups（插件设置），不碰文档、不加块属性。
       所以指标随时可以删，卸载插件后用户的笔记里不会多出任何东西。
       指标段位按「大类 → 指标 → 尺度」三层看：大类是一屏一组指标，
       尺度（日 / 周 / 月）是同一份数据换粒度，分线（空腹 / 餐后）是同一指标的另一维。
       ─────────────────────────────────────────────────────────── */

    /* 当前生效的指标：扁平化成 [{group, metric}]，组名空着时归到「未归类」。
       每次读都重新归一化 —— 指标表很小（几个到几十个），省掉一套缓存失效逻辑，
       改了设置立刻就用新的。 */
    _metrics() {
      const out = [];
      (this.data.metricGroups || []).forEach((g) => {
        (g.items || []).forEach((i) => {
          const metric = normMetric(i);
          /* 名称留空就跟随匹配词里第一个词 —— 这样「只填一个匹配词」的指标
             也能在指标页正常显示，不用逼用户先起名 */
          const name = metric.name || metricKw(metric.match)[0] || "";
          if (name) {
            out.push({
              group: (g.name || "").trim() || "未归类",
              /* 颜色在这里一次性换成「生效色」（绑了类型就跟类型色）。
                 折线 / 面积 / 图例 / 卡头色点全都读 metric.color ——
                 只在这一处换，下游就都跟着走了，不必逐个改。 */
              metric: Object.assign({}, metric, { name, color: this._metricColorOf(metric) }),
            });
          }
        });
      });
      return out;
    }

    /* 指标实际生效的颜色。绑了类型就跟类型的颜色 —— 类型是「归类」，
       它的配色在整个插件里是同一套，指标挂上去自然也该是那个色；
       没绑类型时，才是这个指标自己挑的色。
       类型在类型管理里被删掉或改了名就退回自己存的那个色，
       不至于因为删了一个类型，整张卡突然变成一片灰。 */
    _metricColorOf(metric) {
      const m = metric || {};
      return this._typeColorOf(m.type) || m.color || DEFAULT_TYPE_COLOR;
    }

    /* 卡片上临时切过的尺度优先，否则用指标自己配的默认尺度 */
    _metricScaleOf(metric) {
      const t = this._calTabMetricScale ? this._calTabMetricScale[metric.name] : "";
      return METRIC_SCALES.some((o) => o.value === t) ? t : metric.scale;
    }

    /* 指标只认「记录」，不认「文档」数据源 —— 文档的 content 是标题，没有数值可取。
       所以这里不看设置里的数据源，直接问记录那份缓存；还没加载过就先补一次，
       回来后再重绘指标段位（首屏因此不会空着）。 */
    _metricRecords() {
      if (Array.isArray(this._lifelogDockCache)) return this._lifelogDockCache;
      if (!this._metricLoading) {
        this._metricLoading = true;
        this._queryLifeLogDockRecords()
          .then((records) => {
            this._lifelogDockCache = records || [];
            this._lifelogDockCacheTime = Date.now();
            if (this._calTabView === "metric") this._refreshCalendarTabs();
          })
          .catch((e) => console.warn(`${NAME}：指标数据加载失败`, e))
          .finally(() => {
            this._metricLoading = false;
          });
      }
      return [];
    }

    /* 指标可绑定的记录类型：默认「不限」，候选只列**数据里真实出现过的**类型，
       外加这条指标自己已经存过的那个（最近没记录也还在）。
       不让手打 —— 类型是自由文本，写偏一个字符就静默漏数据。 */
    _metricTypeOptions(current) {
      const names = this._calTabTypeOptions(this._metricRecords()).map((o) => o.name);
      const cur = String(current || "").trim();
      if (cur && names.indexOf(cur) < 0) names.unshift(cur);
      return names.map((name) => ({ value: name, label: name }));
    }

    /* 指标看的那段日期：以锚点为右端、往前 N 天（含右端那天）；
       N = 0 表示「全部」—— 从最早一条记录（不晚于右端）那天算起。
       锚点默认是今天，顶栏的翻页会把它往前挪（见 _bindCalendarTab 里那条分支）。 */
    _metricWindow(records) {
      const anchor =
        this._calTabMetricAnchor instanceof Date ? this._calTabMetricAnchor : new Date();
      const to = this._calKey(anchor);
      const days = parseInt(this._calTabMetricScope, 10);
      if (!Number.isFinite(days) || days <= 0) {
        let from = "";
        (records || []).forEach((r) => {
          const d = r && r.date;
          if (d && d <= to && (!from || d < from)) from = d;
        });
        return { from: from || to, to };
      }
      const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
      d.setDate(d.getDate() - (days - 1));
      return { from: this._calKey(d), to };
    }

    /* 指标段位标题里那段日期。写法与习惯视图的「范围」一致（`9月1日 ~ 11月30日`），
       只有跨年时两头才补上年份 —— 否则「12月31日 ~ 1月5日」读不出是哪一年。 */
    _metricRangeLabel(from, to) {
      const p = (k) => {
        const m = String(k || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
      };
      const a = p(from);
      const b = p(to);
      if (!a || !b) return String(from || "");
      if (a.y !== b.y) {
        return `${a.y}年${a.m}月${a.d}日 ~ ${b.y}年${b.m}月${b.d}日`;
      }
      if (a.m === b.m && a.d === b.d) return `${a.m}月${a.d}日`;
      return `${a.m}月${a.d}日 ~ ${b.m}月${b.d}日`;
    }

    /* 分桶键：日 = 日期；周 = 所在周的起始日（跟着设置里的「一周从周几开始」）；
       月 = YYYY-MM。 */
    _metricBucketKey(dateKey, scale) {
      const key = String(dateKey || "");
      const m = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return key;
      if (scale === "month") return `${m[1]}-${m[2]}`;
      if (scale === "week") {
        const d = new Date(+m[1], +m[2] - 1, +m[3]);
        const ws = this._calWeekStart();
        d.setDate(d.getDate() - ((d.getDay() - ws + 7) % 7));
        return this._calKey(d);
      }
      return key;
    }

    /* 桶的短标签：月 = 「9 月」；周 = 「9/22 起」；日 = 「9/22」 */
    _metricBucketLabel(bucketKey, scale) {
      const m = String(bucketKey).match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
      if (!m) return String(bucketKey);
      if (scale === "month") return `${Number(m[2])} 月`;
      return scale === "week"
        ? `${Number(m[2])}/${Number(m[3])} 起`
        : `${Number(m[2])}/${Number(m[3])}`;
    }

    /* 一段文本里的所有数字。三处归一化都是给真实写法准备的：
       全角数字（中文输入法下很容易打出来）、全角小数点、
       千分位逗号（「12,000 步」别被拆成 12 和 0）。 */
    _metricNumbers(text) {
      const s = String(text == null ? "" : text)
        .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
        .replace(/[．]/g, ".")
        .replace(/(\d),(?=\d{3}(?:\D|$))/g, "$1");
      const out = [];
      const re = /-?\d+(?:\.\d+)?/g;
      let m;
      while ((m = re.exec(s))) {
        const v = Number(m[0]);
        if (Number.isFinite(v)) out.push(v);
      }
      return out;
    }

    /* 时长型：统一换算成小时。认「7小时30分」「7 小时」「7.5h」「7:30」「90 分钟」
       这几种手账里常见的写法；都不认就返回 null（调用方会退回普通数字）。 */
    _metricDuration(text) {
      const s = String(text == null ? "" : text).replace(/[０-９]/g, (c) =>
        String.fromCharCode(c.charCodeAt(0) - 0xfee0)
      );
      const hm = s.match(/(\d+(?:\.\d+)?)\s*(?:个?小时|小时|时|h|hr|hours?)/i);
      const mm = s.match(/(\d+(?:\.\d+)?)\s*(?:分钟|分|min)/i);
      if (hm) {
        let v = Number(hm[1]);
        if (mm) v += Number(mm[1]) / 60;
        return Math.round(v * 100) / 100;
      }
      if (mm) return Math.round((Number(mm[1]) / 60) * 100) / 100;
      const clock = s.match(/(?:^|\D)(\d{1,2}):(\d{2})(?!\d)/);
      if (clock) {
        const h = Number(clock[1]);
        const mi = Number(clock[2]);
        if (mi < 60 && h <= 48) return Math.round((h + mi / 60) * 100) / 100;
      }
      return null;
    }

    /* 一组数字按配置的取值方式收敛成一个值 */
    _metricPick(list, how) {
      if (!list || !list.length) return null;
      if (how === "first") return list[0];
      if (how === "max") return Math.max.apply(null, list);
      if (how === "min") return Math.min.apply(null, list);
      if (how === "sum") return list.reduce((a, b) => a + b, 0);
      if (how === "avg") return list.reduce((a, b) => a + b, 0) / list.length;
      return list[list.length - 1];
    }

    /* 一条记录给某个指标贡献的数值；抽不到返回 null。
       返回值里带上命中的分线词（没配分线词、或没命中 → ""），
       「空腹 / 餐后」这类拆线就靠它。 */
    _metricRecordValue(rec, metric) {
      const text = String((rec && rec.content) || "");
      if (!text) return null;
      /* 绑了类型就只认这个类型的记录（类型是「归类」，指标挂在归类上最自然） */
      const wantType = String(metric.type || "").trim();
      if (wantType && String((rec && rec.type) || "").trim() !== wantType) return null;
      const kws = metricKw(metric.match);
      if (kws.length && !kws.some((k) => text.includes(k))) return null;
      const bad = metricKw(metric.exclude);
      if (bad.length && bad.some((k) => text.includes(k))) return null;
      const splitKws = metricKw(metric.split);
      const split = splitKws.find((k) => text.includes(k)) || "";
      /* 先圈出要读的那一段：配了匹配词就取第一个匹配词往后 40 个字
         （在下一个分线词处截断 —— 「空腹血糖 5.6 餐后 7.8」写成一行的记录，
         读空腹那条线时不能把餐后的值也卷进来）。
         那一段里既没有数字也没有时长，才退回整条内容。 */
      let seg = text;
      if (kws.length) {
        let at = -1;
        kws.forEach((k) => {
          const i = text.indexOf(k);
          if (i >= 0 && (at < 0 || i < at)) at = i;
        });
        if (at >= 0) {
          let end = at + 40;
          splitKws.forEach((k) => {
            const i = text.indexOf(k, at + 1);
            if (i >= 0 && i < end) end = i;
          });
          const slice = text.slice(at, end);
          if (this._metricNumbers(slice).length || this._metricDuration(slice) !== null) {
            seg = slice;
          }
        }
      }
      /* 时长还是普通数字：配置写死了就照写死的读；
         auto（默认）看这一段里有没有时长单位 —— 这样「睡眠 7小时30分」和「体重 65.5」
         都不用用户去选一个「数值类型」 */
      const asDuration =
        metric.kind === "duration" ||
        (metric.kind !== "number" &&
          /(?:\d\s*(?:个?小时|小时|时|h|hr|hours?|分钟|分|min))|(?:\d{1,2}:\d{2}(?!\d))/i.test(seg));
      let nums;
      if (asDuration) {
        const h = this._metricDuration(seg);
        nums = h === null ? this._metricNumbers(seg) : [h];
      } else {
        nums = this._metricNumbers(seg);
      }
      if (!nums.length) return null;
      const value = this._metricPick(nums, metric.pick);
      return value === null ? null : { value, split };
    }

    /* 一个指标的数据点：
         keys   —— x 轴的桶键（所有分线的并集、排序后），多条线共用一根轴
         lines  —— [{ key, name, color, points: [{key, label, value, count}] }]
         hits   —— 命中并抽到值的条数
         misses —— 命中关键词却没抽到数字的条数（卡片上要提示，见 _metricCardHtml） */
    _metricSeries(records, metric, window) {
      const scale = this._metricScaleOf(metric);
      const splitKws = metricKw(metric.split);
      const kws = metricKw(metric.match);
      const bad = metricKw(metric.exclude);
      /* 类型不符的记录连「未取到数字」都不算 —— 它压根不是这个指标的记录 */
      const wantType = String(metric.type || "").trim();
      const typeOk = (rec) =>
        !wantType || String((rec && rec.type) || "").trim() === wantType;
      const buckets = new Map();
      const allKeys = new Set();
      let hits = 0;
      let misses = 0;
      /* 先按「日期 + 时间」升序排一遍再用。
         记录从 SQL 来的时候是日期倒序的，而「取值 = 最后一条 / 第一条」要的是
         **当天时间上**的最后 / 最前一条 —— 不排的话，同一天里测两次体重会取错那个。
         顺手把区间外的剔掉，后面就不用每条都判一次。 */
      const rows = (records || [])
        .filter(
          (rec) =>
            rec &&
            rec.date &&
            (!window || (rec.date >= window.from && rec.date <= window.to))
        )
        .sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
      rows.forEach((rec) => {
        const got = this._metricRecordValue(rec, metric);
        if (!got) {
          /* 命中关键词却没抽到数字：单独计数。这个功能最容易被当成"插件坏了"
             的就是这种情况，得让用户一眼能自查（卡片脚注会写出来）。 */
          const text = String(rec.content || "");
          const hit =
            typeOk(rec) &&
            (!kws.length || kws.some((k) => text.includes(k))) &&
            !bad.some((k) => text.includes(k));
          if (hit && text.trim()) misses++;
          return;
        }
        hits++;
        const bucketKey = this._metricBucketKey(rec.date, scale);
        allKeys.add(bucketKey);
        const lineKey = got.split || "";
        if (!buckets.has(lineKey)) buckets.set(lineKey, new Map());
        const cells = buckets.get(lineKey);
        if (!cells.has(bucketKey)) {
          cells.set(bucketKey, { n: 0, sum: 0, last: 0, first: 0, max: -Infinity, min: Infinity });
        }
        const cell = cells.get(bucketKey);
        if (cell.n === 0) cell.first = got.value;
        cell.n += 1;
        cell.sum += got.value;
        cell.last = got.value;
        cell.max = Math.max(cell.max, got.value);
        cell.min = Math.min(cell.min, got.value);
      });
      const keys = Array.from(allKeys).sort();
      /* 按分线词在配置里写的顺序排；没带上分线词的那一组（""）放最后，
         图例读起来就是「空腹 / 餐后 / 未标注」 */
      const lineKeys = Array.from(buckets.keys()).sort((a, b) => {
        if (a === b) return 0;
        if (!a) return 1;
        if (!b) return -1;
        return splitKws.indexOf(a) - splitKws.indexOf(b);
      });
      const colors = this._metricLineColors(metric.color, lineKeys.length);
      const lines = lineKeys.map((lineKey, idx) => ({
        key: lineKey,
        /* 没配分线词时，这条线的名字就是指标名（气泡里显示「体重 · 9/1 · 65.5 kg」）；
           配了分线词、却有些记录没带上分线词的，那些点单独成一条「未标注」线 ——
           不然图例里会出现「血糖 / 空腹 / 餐后」三条，第一条叫什么说不清 */
        name: lineKey || (splitKws.length ? "未标注" : metric.name),
        color: colors[idx],
        points: Array.from(buckets.get(lineKey).keys())
          .sort()
          .map((bucketKey) => {
            const cell = buckets.get(lineKey).get(bucketKey);
            /* 桶内留空 = 跟随「取值」（同一个词管两级：一条内容里怎么取、一个桶里怎么并） */
            let value;
            switch (metric.bucket || metric.pick) {
              case "first": value = cell.first; break;
              case "avg": value = cell.sum / cell.n; break;
              case "max": value = cell.max; break;
              case "min": value = cell.min; break;
              case "sum": value = cell.sum; break;
              default: value = cell.last;
            }
            return {
              key: bucketKey,
              label: this._metricBucketLabel(bucketKey, scale),
              value,
              count: cell.n,
            };
          }),
      }));
      return { keys, lines, hits, misses, scale };
    }

    /* 同一指标的多条线（空腹 / 餐后）用色相旋转区分：第一条原色，
       其余前后小幅偏移 —— 一眼看出是一家人，又不会混成一条。 */
    _metricLineColors(base, count) {
      const rgba =
        parseColor(base) || parseColor(DEFAULT_TYPE_COLOR) || { r: 122, g: 173, b: 255, a: 1 };
      const hsv = rgbToHsv(rgba);
      const out = [];
      for (let i = 0; i < Math.max(1, count); i++) {
        if (i === 0) {
          out.push(rgbaToCss({ r: rgba.r, g: rgba.g, b: rgba.b, a: 1 }));
          continue;
        }
        const rgb = hsvToRgb(hsv.h + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 28, hsv.s, hsv.v);
        out.push(rgbaToCss({ r: rgb.r, g: rgb.g, b: rgb.b, a: 1 }));
      }
      return out;
    }

    /* 数值的显示文本（小数位按指标配置，带单位） */
    _metricFmt(value, metric) {
      if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
      const text = Number(value).toFixed(metric.decimals);
      return metric.unit ? `${text} ${metric.unit}` : text;
    }

    /* 一张折线图。坐标空间**按卡片的真实宽度来定**（见 _fitMetricCharts）：
       SVG 里的字号会跟着 viewBox 缩放，坐标空间写死一个值的话，
       卡片宽到 1090px 时字就涨成 24px、窄到 400px 时又缩成 5px（这坑两头都踩过）。
       所以这里接收一个 width，图和字都按它算 —— 缩放比恒为 1:1，字号永远就是 13px 那一档。
       另外三处是给「数值型折线」特意做的：
         1. 纵轴不从 0 起 —— 体重 65 上下的折线从 0 起就是一条直线，这里按数据范围取；
         2. 刻度取整数档（1 / 2 / 5 × 10^k）—— 四等分会算出 65.9 / 65.5 这种读数别扭的
            刻度，手账本那种图都是能一眼读出来的整数；
         3. 左边留出一条刻度带 —— 折线不从 x=0 起笔，第一个点不会压在刻度字上。 */
    _metricChartSvg(series, metric, width) {
      const WIDTH = Math.min(1600, Math.max(320, Math.round(width || 580)));
      /* 高度跟着宽度走但夹在 190~320 之间：太窄了要够高才看得清折线，
         太宽了不必跟着等比拉高（否则一屏只能塞一张卡） */
      const HEIGHT = Math.round(Math.min(320, Math.max(190, WIDTH * 0.34)));
      const PAD_T = 18;
      const PAD_B = 44;
      const PAD_L = 46;
      const PAD_R = 10;
      const plotH = HEIGHT - PAD_T - PAD_B;
      const values = [];
      series.lines.forEach((l) => l.points.forEach((p) => values.push(p.value)));
      if (!values.length) return "";
      let lo = Math.min.apply(null, values);
      let hi = Math.max.apply(null, values);
      const hasTarget = metric.target !== null && Number.isFinite(metric.target);
      if (hasTarget) {
        lo = Math.min(lo, metric.target);
        hi = Math.max(hi, metric.target);
      }
      let span = hi - lo;
      if (span <= 0) span = Math.abs(hi) > 1 ? Math.abs(hi) * 0.2 : 1;
      /* 刻度步长取 1 / 2 / 5 × 10^k，再把上下界对齐到步长的整数倍 */
      const rawStep = (span * 1.24) / 4;
      const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
      const ratio = rawStep / mag;
      const step = mag * (ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 5 ? 5 : 10);
      let y0 = Math.floor((lo - span * 0.12) / step) * step;
      let y1 = Math.ceil((hi + span * 0.12) / step) * step;
      if (!Number.isFinite(y0) || !Number.isFinite(y1) || y1 <= y0) {
        y0 = lo - span * 0.12;
        y1 = hi + span * 0.12;
      }
      const yOf = (v) => PAD_T + plotH - ((v - y0) / (y1 - y0)) * plotH;
      const n = series.keys.length;
      const xOf = (key) => {
        const i = series.keys.indexOf(key);
        return n > 1
          ? PAD_L + ((WIDTH - PAD_L - PAD_R) * i) / (n - 1)
          : (WIDTH + PAD_L - PAD_R) / 2;
      };
      const baseY = (PAD_T + plotH).toFixed(1);
      let svg = "";
      /* 刻度线：从 y0 到 y1 按步长铺，最多 6 条（步长很小时不至于糊成一片） */
      const ticks = [];
      for (let i = 0; i <= 12; i++) {
        const v = y0 + i * step;
        if (v > y1 + step / 1000) break;
        ticks.push(v);
      }
      if (ticks.length > 6) {
        ticks.length = 0;
        for (let i = 0; i <= 4; i++) ticks.push(y0 + ((y1 - y0) * i) / 4);
      }
      ticks.forEach((v) => {
        const y = yOf(v);
        svg += `<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${WIDTH - PAD_R}" y2="${y.toFixed(
          1
        )}" stroke="var(--b3-border-color)" stroke-dasharray="4 5" stroke-width="1" opacity="0.55"/>`;
        svg += `<text x="4" y="${(y + 4).toFixed(
          1
        )}" class="north-caltab-stats-axis-text">${v.toFixed(metric.decimals)}</text>`;
      });
      if (hasTarget) {
        const ty = yOf(metric.target);
        svg += `<line x1="${PAD_L}" y1="${ty.toFixed(1)}" x2="${WIDTH - PAD_R}" y2="${ty.toFixed(
          1
        )}" stroke="var(--b3-theme-on-surface-light)" stroke-width="1" stroke-dasharray="2 3" opacity="0.85"/>`;
        svg += `<text x="${WIDTH - PAD_R}" y="${(ty - 5).toFixed(
          1
        )}" text-anchor="end" class="north-caltab-stats-axis-text">目标 ${metric.target}</text>`;
      }
      /* 面积先画、折线后画 —— 反过来的话折线会被自己的半透明面积盖住 */
      series.lines.forEach((line) => {
        if (line.points.length < 2) return;
        const pts = line.points.map((p) => `${xOf(p.key).toFixed(1)},${yOf(p.value).toFixed(1)}`);
        svg += `<path d="M${pts.join(" L")} L${xOf(
          line.points[line.points.length - 1].key
        ).toFixed(1)},${baseY} L${xOf(line.points[0].key).toFixed(1)},${baseY} Z" class="north-caltab-metric-area" style="fill:${line.color}"/>`;
      });
      series.lines.forEach((line) => {
        if (!line.points.length) return;
        const pts = line.points.map((p) => `${xOf(p.key).toFixed(1)},${yOf(p.value).toFixed(1)}`);
        svg += `<path d="M${pts.join(
          " L"
        )}" class="north-caltab-metric-line" style="stroke:${line.color}"/>`;
        line.points.forEach((p) => {
          const cx = xOf(p.key).toFixed(1);
          const cy = yOf(p.value).toFixed(1);
          const tip = escapeHtml(
            `${line.name} · ${p.label} · ${this._metricFmt(p.value, metric)}${
              p.count > 1 ? ` · ${p.count} 条` : ""
            }`
          );
          svg += `<circle cx="${cx}" cy="${cy}" r="${
            line.points.length > 40 ? 8 : 12
          }" fill="transparent" class="north-caltab-stats-hit" data-tip="${tip}"/>`;
          svg += `<circle cx="${cx}" cy="${cy}" r="4" class="north-caltab-metric-dot" style="stroke:${line.color}"/>`;
        });
      });
      /* x 轴标签：点多了隔几个画一个，首尾一定画；首尾改左右对齐免得被裁掉 */
      const marks = [];
      const stride = n > 10 ? Math.ceil(n / 6) : 1;
      for (let i = 0; i < n; i += stride) marks.push(i);
      if (n && marks[marks.length - 1] !== n - 1) marks.push(n - 1);
      marks.forEach((i) => {
        const x = xOf(series.keys[i]);
        const anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
        svg += `<text x="${x.toFixed(1)}" y="${
          HEIGHT - 16
        }" text-anchor="${anchor}" class="north-caltab-stats-axis-text">${escapeHtml(
          this._metricBucketLabel(series.keys[i], series.scale)
        )}</text>`;
      });
      return `<svg class="north-caltab-metric-chart" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeHtml(
        metric.name
      )}走势图">${svg}</svg>`;
    }

    /* 指标段位的主体：按大类分节，一指标一张卡；还没指标时给一句指路的空态 */
    _buildCalendarMetricHtml() {
      /* 指标数据暂存表：卡片里先留一个空盒子，等整屏插进 DOM、量到真实宽度，
         再由 _fitMetricCharts 取这份数据成图（每次重绘换一份） */
      this._metricRenderCache = new Map();
      const all = this._metrics();
      if (!all.length) return this._metricEmptyHtml();
      /* 顶栏那枚「全部类型」在指标视图里也照常管用：先按选中的类型过一遍记录，
         后面的取数、脚注统计都基于筛过之后的这一份 */
      const picked = this._calTabTypeFilter;
      const records = picked && picked.size
        ? this._metricRecords().filter((r) => picked.has(String((r && r.type) || "").trim()))
        : this._metricRecords();
      const window = this._metricWindow(records);
      const groups = [];
      all.forEach((x) => {
        let g = groups.find((it) => it.name === x.group);
        if (!g) {
          g = { name: x.group, items: [] };
          groups.push(g);
        }
        g.items.push(x.metric);
      });
      const scopeSegs = METRIC_SCOPES.map(
        (o) =>
          `<button class="${
            String(this._calTabMetricScope) === o.value ? "active" : ""
          }" data-caltab-metric-scope="${o.value}">${o.label}</button>`
      ).join("");
      let seq = 0;
      const sections = groups
        .map((g) => {
          const cards = g.items
            .map((m) => this._metricCardHtml(m, records, window, `m${seq++}`))
            .join("");
          return `<div class="north-caltab-metric-group">
              <div class="north-caltab-metric-grouphead">
                <span class="north-caltab-metric-groupname">${escapeHtml(g.name)}</span>
                <span class="north-caltab-metric-groupcount">${g.items.length} 个指标</span>
              </div>
              <div class="north-caltab-metric-cards">${cards}</div>
            </div>`;
        })
        .join("");
      /* 工具行只留「看多长」的段位：日期已经写在标题里（与习惯视图同款），
         「管理指标」入口也不在这里重复 —— 它在「设置 · 指标设置」里，只留一处。 */
      return `<div class="north-caltab-metric">
          <div class="north-caltab-metric-bar">
            <div class="north-caltab-segments north-caltab-metric-scopes">${scopeSegs}</div>
          </div>
          ${sections}
        </div>`;
    }

    /* 单个指标的卡片：卡头（名称 / 最近值 / 变化 / 尺度段位）＋ 图例 ＋ 折线 ＋ 脚注。
       折线先留一个空盒子，等整屏插进 DOM 之后由 _fitMetricCharts 按卡片真实宽度二次成图 ——
       这里不知道卡片会渲染成多宽，写死宽度就会一会儿太大一会儿太小。 */
    _metricCardHtml(metric, records, window, cacheKey) {
      const series = this._metricSeries(records, metric, window);
      const points = series.lines.reduce((n, l) => n + l.points.length, 0);
      const scaleSegs = METRIC_SCALES.map(
        (o) =>
          `<button class="${
            this._metricScaleOf(metric) === o.value ? "active" : ""
          }" data-caltab-metric-scale="${o.value}" data-caltab-metric-name="${escapeHtml(
            metric.name
          )}">${o.label}</button>`
      ).join("");
      /* 最近值取「最后有数据的那条线」的最后一点；变化量取同一条线上一个点的差 */
      let lastPoint = null;
      let lineOfLast = null;
      series.lines.forEach((l) => {
        const p = l.points[l.points.length - 1];
        if (p && (!lastPoint || p.key > lastPoint.key)) {
          lastPoint = p;
          lineOfLast = l;
        }
      });
      let delta = null;
      if (lineOfLast && lastPoint) {
        const idx = lineOfLast.points.indexOf(lastPoint);
        if (idx > 0) delta = lastPoint.value - lineOfLast.points[idx - 1].value;
      }
      /* 周 / 月的「求和」刻度下，最后那一格往往还没走完 —— 拿它跟上一格比出来的差
         会突然很大（这周才过三天 vs 上周满七天），看着像暴跌。未走完的周期不给差值。 */
      if (
        delta !== null &&
        series.scale !== "day" &&
        lastPoint &&
        lastPoint.key === this._metricBucketKey(this._calKey(new Date()), series.scale)
      ) {
        delta = null;
      }
      const legend =
        series.lines.length > 1
          ? `<div class="north-caltab-metric-legend">${series.lines
              .map(
                (l) =>
                  `<span class="north-caltab-metric-legenditem"><i style="background:${
                    l.color
                  }"></i>${escapeHtml(l.name)}</span>`
              )
              .join("")}</div>`
          : "";
      const foot = [`${series.hits} 条记录`];
      if (series.misses > 0) {
        foot.push(`${series.misses} 条命中但没取到数字，可检查内容写法或「匹配词」`);
      }
      /* 交给二次成图：把这一个指标的数据存下，等量出卡片宽度再画 */
      if (cacheKey && points) {
        this._metricRenderCache.set(cacheKey, { metric, series });
      }
      return `<div class="north-caltab-metric-card${points ? "" : " is-empty"}">
          <div class="north-caltab-metric-head">
            <span class="north-caltab-metric-chipdot" style="background:${metric.color}"></span>
            <span class="north-caltab-metric-name">${escapeHtml(metric.name)}</span>
            ${
              metric.type
                ? `<span class="north-caltab-metric-type" data-tip="只统计「${escapeHtml(
                    metric.type
                  )}」类型的记录">${escapeHtml(metric.type)}</span>`
                : ""
            }
            <span class="north-caltab-metric-last">${
              lastPoint
                ? `最近 <b>${Number(lastPoint.value).toFixed(metric.decimals)}</b>${
                    metric.unit ? " " + escapeHtml(metric.unit) : ""
                  }`
                : "暂无数据"
            }</span>
            ${
              delta === null
                ? ""
                : `<span class="north-caltab-metric-delta">${
                    delta >= 0 ? "+" : ""
                  }${delta.toFixed(metric.decimals)}</span>`
            }
            <div class="north-caltab-segments north-caltab-metric-scales">${scaleSegs}</div>
          </div>
          ${legend}
          ${
            points
              ? `<div class="north-caltab-metric-chartbox" data-caltab-metric-chart="${escapeHtml(
                  cacheKey
                )}"></div>`
              : `<div class="north-caltab-metric-none">这段区间里没找到「${escapeHtml(
                  metric.match || metric.name
                )}」的数值</div>`
          }
          <div class="north-caltab-metric-foot">${escapeHtml(foot.join(" · "))}</div>
        </div>`;
    }

    /* 按每张卡的**真实宽度**逐张重画折线。
       为什么必须二次成图：SVG 里的字号跟着 viewBox 缩放，坐标空间写死就必然
       一头太小一头太大（实测：卡片 400px 时字号缩到 5px、1090px 时涨到 24px）。
       这里量出卡片宽度，用同宽的坐标空间重画，缩放比就是 1:1。
       顺带挂一个 ResizeObserver：标签页在后台创建时量不到宽度（clientWidth 为 0），
       等它可见、或用户拖宽窗口之后再补一次 —— 与月视图对齐那套是同一个路子。 */
    _fitMetricCharts(container) {
      if (!container || !this._metricRenderCache) return;
      const boxes = container.querySelectorAll("[data-caltab-metric-chart]");
      boxes.forEach((box) => {
        const hit = this._metricRenderCache.get(
          box.getAttribute("data-caltab-metric-chart") || ""
        );
        if (!hit) return;
        const draw = () => {
          const w = Math.round(box.clientWidth || 0);
          /* 量不到宽度（后台标签页）时按默认宽度先画一版，别留空 */
          const width = w > 0 ? w : 580;
          if (box._metricW === width && box.firstChild) return;
          box._metricW = width;
          box.innerHTML = this._metricChartSvg(hit.series, hit.metric, width);
        };
        draw();
        if (typeof ResizeObserver === "function" && box._metricRO !== true) {
          box._metricRO = true;
          const ro = new ResizeObserver(() => {
            if (!box.isConnected) {
              ro.disconnect();
              return;
            }
            draw();
          });
          ro.observe(box);
        }
      });
    }

    /* 还没有指标时的空态：与习惯视图的空态同一个样子 ——
       一句说明 + 一枚「去设置」，点了直接落到「设置 · 指标设置」。
       这里不摆任何操作项：建、改都在「设置 · 指标设置」里做。 */
    _metricEmptyHtml() {
      return `<div class="north-caltab-metric north-caltab-metric--empty">
          <div class="north-caltab-metric-empty">
            <div class="north-caltab-metric-empty-title">还没有指标</div>
            <div class="north-caltab-metric-empty-desc">去「设置 → 指标设置」里建一个：填一个内容里会出现的词，就围绕它生成一个指标。</div>
            <button class="north-caltab-metric-empty-btn" type="button" data-caltab-act="settings" data-settings-group="metric">去设置</button>
          </div>
        </div>`;
    }

    /* 指标改动的落盘：输入框里每敲一下都写盘太吵，攒 400ms 一起写
       （同 _typesDirty 那套；关窗与卸载时会各补一次） */
    _saveMetrics() {
      this._metricsDirty = true;
      clearTimeout(this._metricsTimer);
      this._metricsTimer = setTimeout(() => this._flushMetrics(), 400);
    }

    _flushMetrics() {
      if (this._metricsTimer) {
        clearTimeout(this._metricsTimer);
        this._metricsTimer = null;
      }
      if (!this._metricsDirty) return;
      this._metricsDirty = false;
      this._persist("保存指标");
    }

    /* 打开「指标管理」弹窗（复用类型管理那套 .tt-modal 骨架：拖拽、ESC、点遮罩关闭） */
    _openMetricManagerModal(onClose) {
      if (this._metricModal) {
        this._metricModal.remove();
        this._metricModal = null;
      }
      const modal = document.createElement("div");
      modal.className = "tt-modal";
      modal.innerHTML = `
        <div class="tt-modal__backdrop"></div>
        <div class="tt-modal__panel">
          <div class="tt-modal__header">
            <span class="tt-modal__header-title">指标管理</span>
            <button class="tt-modal__close" type="button" aria-label="关闭">×</button>
          </div>
          <div class="tt-modal__body"></div>
        </div>
      `;
      modal.querySelector(".tt-modal__body").appendChild(this._buildMetricSettings());

      const panel = modal.querySelector(".tt-modal__panel");
      const header = modal.querySelector(".tt-modal__header");
      let dragging = false;
      let startX = 0;
      let startY = 0;
      let baseLeft = 0;
      let baseTop = 0;

      const ensurePositioned = () => {
        if (panel.style.position === "fixed") return;
        const r = panel.getBoundingClientRect();
        panel.style.position = "fixed";
        panel.style.margin = "0";
        panel.style.left = r.left + "px";
        panel.style.top = r.top + "px";
      };
      const onMove = (e) => {
        if (!dragging) return;
        let nx = baseLeft + (e.clientX - startX);
        let ny = baseTop + (e.clientY - startY);
        nx = Math.max(8, Math.min(nx, window.innerWidth - panel.offsetWidth - 8));
        ny = Math.max(8, Math.min(ny, window.innerHeight - panel.offsetHeight - 8));
        panel.style.left = nx + "px";
        panel.style.top = ny + "px";
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        header.classList.remove("tt-modal__header--dragging");
        document.body.style.userSelect = "";
      };
      header.addEventListener("mousedown", (e) => {
        if (e.target.closest(".tt-modal__close")) return;
        ensurePositioned();
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        baseLeft = panel.getBoundingClientRect().left;
        baseTop = panel.getBoundingClientRect().top;
        header.classList.add("tt-modal__header--dragging");
        document.body.style.userSelect = "none";
        e.preventDefault();
      });
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      const onKey = (e) => {
        if (e.key === "Escape") close();
      };
      const close = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.removeEventListener("keydown", onKey, true);
        /* 取色面板挂在 body 上，不随弹窗销毁，得手动收掉 */
        if (typeof this._closeColorPicker === "function") this._closeColorPicker();
        modal.remove();
        if (this._metricModal === modal) this._metricModal = null;
        /* 关窗前把攒着的改动落盘，再通知调用方重绘指标段位 */
        this._flushMetrics();
        if (typeof onClose === "function") {
          try {
            onClose();
          } catch (e) {
            console.warn(`${NAME}：指标管理关闭回调失败`, e);
          }
        }
      };
      document.addEventListener("keydown", onKey, true);
      modal.querySelector(".tt-modal__backdrop").addEventListener("click", close);
      modal.querySelector(".tt-modal__close").addEventListener("click", close);
      document.body.appendChild(modal);
      ensurePositioned();
      this._metricModal = modal;
    }

    /* 指标管理面板：大类（一个盒子）＋ 盒子里若干指标卡片。
       极简优先 —— 一张卡默认只露两样：**匹配词**（唯一必填，填一个词就能用）和
       「更多」开关（名称、单位、目标值、小数位、分线词、排除词、取值、桶内、尺度都在里面）。
       已经设过高级项的老配置会自动展开那一张卡，免得用户以为设置丢了。
       数值类型不再让人选：解析时自动判断（内容里带「小时 / 分钟」这类时长单位就按时长读）。 */
    _buildMetricSettings() {
      const wrap = document.createElement("div");
      wrap.className = "tt-metrics";
      wrap.innerHTML = `
        <div class="tt-metrics__intro">填一个内容里会出现的词，就围绕它生成一个指标。其余设置收在「更多」里，按需展开。</div>
        <div class="tt-metrics__groups"></div>
        <button class="tt-metrics__group-add" type="button"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><use xlink:href="#iconAdd"></use></svg> 添加大类</button>
        <div class="tt-metrics__hint">改动即时保存；关掉这个窗口后指标段位会刷新。</div>
      `;
      const groupsEl = wrap.querySelector(".tt-metrics__groups");

      const segRow = (label, options, current, onPick) => {
        const row = document.createElement("div");
        row.className = "tt-metrics__field";
        row.innerHTML = `<span class="tt-metrics__label">${label}</span><span class="tt-metrics__seg"></span>`;
        const seg = row.querySelector(".tt-metrics__seg");
        options.forEach((o) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "tt-metrics__segbtn" + (o.value === current ? " on" : "");
          btn.textContent = o.label;
          btn.addEventListener("click", () => {
            seg
              .querySelectorAll(".tt-metrics__segbtn")
              .forEach((b) => b.classList.remove("on"));
            btn.classList.add("on");
            onPick(o.value);
          });
          seg.appendChild(btn);
        });
        return row;
      };

      const metricEl = (metric, gi, mi) => {
        /* 卡片上拿到的是**原始**配置对象，字段可能压根没写过（新建的指标只有 match）。
           所以显示值与「算不算高级项」都先过一遍归一化，免得出现空高亮、
           或者 小数位 显示成 undefined。改的仍是原对象。 */
        const nm = normMetric(metric);
        const el = document.createElement("div");
        el.className = "tt-metrics__item";
        el.innerHTML = `
          <div class="tt-metrics__item-head">
            <button type="button" class="tt-metrics__item-color" title="指标颜色"></button>
            <input type="text" class="tt-metrics__item-kw" data-f="match" placeholder="匹配词：内容里出现的词" />
            <button type="button" class="tt-metrics__item-more">更多</button>
            <button class="tt-metrics__item-remove" type="button" title="删除该指标"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><use xlink:href="#iconMin"></use></svg></button>
          </div>
          <div class="tt-metrics__item-extra" hidden>
            <div class="tt-metrics__item-row">
              <input type="text" class="tt-metrics__item-name" placeholder="名称（留空跟随匹配词）" maxlength="12" />
              <input type="text" class="tt-metrics__item-unit" placeholder="单位" maxlength="8" />
              <input type="text" class="tt-metrics__item-target" placeholder="目标值" />
              <label class="tt-metrics__decimals"><span>小数位</span><input type="number" class="tt-metrics__item-dec" min="0" max="4" step="1" /></label>
            </div>
            <div class="tt-metrics__item-row">
              <input type="text" class="tt-metrics__item-split" placeholder="分线词：按它拆成多条线" />
              <input type="text" class="tt-metrics__item-exclude" placeholder="排除词：出现就跳过" />
            </div>
            <div class="tt-metrics__item-segs"></div>
          </div>
        `;
        const colorBtn = el.querySelector(".tt-metrics__item-color");
        const matchInput = el.querySelector('[data-f="match"]');
        const moreBtn = el.querySelector(".tt-metrics__item-more");
        const extra = el.querySelector(".tt-metrics__item-extra");
        const nameInput = el.querySelector(".tt-metrics__item-name");
        const unitInput = el.querySelector(".tt-metrics__item-unit");
        const targetInput = el.querySelector(".tt-metrics__item-target");
        const decInput = el.querySelector(".tt-metrics__item-dec");
        const splitInput = el.querySelector(".tt-metrics__item-split");
        const excludeInput = el.querySelector(".tt-metrics__item-exclude");
        const removeBtn = el.querySelector(".tt-metrics__item-remove");

        /* 绑了类型时这个色块只是「显示」类型色：点了也不该能改 ——
           改了不会生效，让人白忙一场。要换颜色请去「设置 · 类型管理」改类型色。 */
        const picker = this._initColorPicker(colorBtn, {
          color: this._metricColorOf(metric),
          onChange: (hex) => {
            metric.color = hex;
            this._saveMetrics();
          },
          canOpen: () => {
            /* 判据跟色块的「跟随态」一致：**颜色确实由类型决定**才拦。
               绑的类型在类型表里查不到色（没配过 / 被删了）时，颜色还是指标自己的，
               那就照旧让人改 —— 否则会出现「显示的是我的色、却点不动」的怪事。 */
            const typeColor = this._typeColorOf(metric.type);
            if (!typeColor) return true;
            showMessage(`${NAME}：颜色跟随类型「${String(metric.type).trim()}」，改颜色请到「设置 · 类型管理」`);
            return false;
          },
        });
        /* 色块跟着类型一起换：留空时画自己的色、可点；绑了类型就画类型色、去掉可点的样子 */
        const syncMetricColor = () => {
          const typeColor = this._typeColorOf(metric.type);
          colorBtn.classList.toggle("is-follow", !!typeColor);
          picker.setColor(typeColor || metric.color || DEFAULT_TYPE_COLOR);
          colorBtn.title = typeColor
            ? `跟随类型「${String(metric.type).trim()}」的颜色`
            : "指标颜色";
        };
        /* 类型（可选）：**先选类型，再在这个类型的内容里找匹配词** ——
           与记录结构「时间 类型：内容」对齐。不选就是「不限类型」，
           行为与加类型之前完全一致（老配置没有这个字段，一并走这条）。 */
        const typeCddl = this._buildCddl({
          options: [{ value: "", label: "不限类型" }].concat(this._metricTypeOptions(nm.type)),
          value: nm.type,
          placeholder: "不限类型",
          onChange: (v) => {
            metric.type = v;
            this._saveMetrics();
            /* 一选完就换色 —— 不然要关窗重开才看得到 */
            syncMetricColor();
          },
        });
        typeCddl.classList.add("tt-metrics__item-type");
        matchInput.parentNode.insertBefore(typeCddl, matchInput);
        syncMetricColor();

        /* 让「新建后聚焦到匹配词」找得到这个输入框 */
        matchInput._metric = metric;
        matchInput.value = nm.match;
        nameInput.value = nm.name;
        unitInput.value = nm.unit;
        targetInput.value = nm.target === null ? "" : String(nm.target);
        decInput.value = String(nm.decimals);
        splitInput.value = nm.split;
        excludeInput.value = nm.exclude;

        /* 设过高级项的（排除词 / 分线词 / 目标 / 小数位 / 尺度 / 桶内）默认展开，
           否则用户打开管理窗口会以为自己的配置丢了 */
        const advanced =
          !!nm.exclude ||
          !!nm.split ||
          nm.target !== null ||
          nm.decimals !== 1 ||
          nm.scale !== "day" ||
          !!nm.bucket;
        if (advanced) extra.hidden = false;
        moreBtn.classList.toggle("on", advanced);
        moreBtn.addEventListener("click", () => {
          extra.hidden = !extra.hidden;
          moreBtn.classList.toggle("on", !extra.hidden);
        });

        /* 字段都直接改属性对象（就是 data.metricGroups 里的那个），攒 400ms 一起落盘 */
        const bind = (input, key, read) => {
          input.addEventListener("input", () => {
            metric[key] = read ? read(input) : input.value.trim();
            this._saveMetrics();
          });
        };
        bind(matchInput, "match");
        bind(nameInput, "name");
        bind(unitInput, "unit");
        bind(splitInput, "split");
        bind(excludeInput, "exclude");
        bind(targetInput, "target");
        bind(decInput, "decimals", (inp) => {
          const n = Math.round(Number(inp.value));
          return Number.isFinite(n) ? Math.max(0, Math.min(4, n)) : 1;
        });
        removeBtn.addEventListener("click", () => {
          this.data.metricGroups[gi].items.splice(mi, 1);
          this._saveMetrics();
          render();
        });

        const segs = el.querySelector(".tt-metrics__item-segs");
        segs.appendChild(
          segRow("取值", METRIC_PICKS, nm.pick, (v) => {
            metric.pick = v;
            this._saveMetrics();
          })
        );
        segs.appendChild(
          segRow(
            "桶内",
            [{ value: "", label: "跟随取值" }].concat(METRIC_BUCKETS),
            nm.bucket,
            (v) => {
              metric.bucket = v;
              this._saveMetrics();
            }
          )
        );
        segs.appendChild(
          segRow("尺度", METRIC_SCALES, nm.scale, (v) => {
            metric.scale = v;
            this._saveMetrics();
          })
        );
        return el;
      };

      const groupEl = (group, gi) => {
        const el = document.createElement("div");
        el.className = "tt-metrics__group";
        el.innerHTML = `
          <div class="tt-metrics__group-head">
            <input type="text" class="tt-metrics__group-name" placeholder="大类名，可留空" maxlength="12" />
            <button class="tt-metrics__group-remove" type="button" title="删除大类"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><use xlink:href="#iconMin"></use></svg></button>
          </div>
          <div class="tt-metrics__group-items"></div>
          <button class="tt-metrics__item-add" type="button"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><use xlink:href="#iconAdd"></use></svg> 添加指标</button>
        `;
        const nameInput = el.querySelector(".tt-metrics__group-name");
        const itemsEl = el.querySelector(".tt-metrics__group-items");
        nameInput.value = group.name || "";
        nameInput.addEventListener("input", () => {
          group.name = nameInput.value.trim();
          this._saveMetrics();
        });
        el.querySelector(".tt-metrics__group-remove").addEventListener("click", () => {
          this.data.metricGroups.splice(gi, 1);
          this._saveMetrics();
          render();
        });
        el.querySelector(".tt-metrics__item-add").addEventListener("click", () => {
          if (!Array.isArray(group.items)) group.items = [];
          const fresh = normMetric({ match: "", color: this._pickFreeMetricColor() });
          group.items.push(fresh);
          this._saveMetrics();
          /* 新建即聚焦到匹配词 —— 这是整张卡唯一必填的一项 */
          render(fresh);
        });
        (group.items || []).forEach((m, mi) => {
          if (!m.color) m.color = this._pickFreeMetricColor();
          itemsEl.appendChild(metricEl(m, gi, mi));
        });
        return el;
      };

      const render = (focusMetric) => {
        groupsEl.replaceChildren();
        if (!Array.isArray(this.data.metricGroups)) this.data.metricGroups = [];
        this.data.metricGroups.forEach((g, gi) => groupsEl.appendChild(groupEl(g, gi)));
        if (focusMetric) {
          groupsEl.querySelectorAll('[data-f="match"]').forEach((inp) => {
            if (inp._metric === focusMetric) inp.focus();
          });
        }
      };
      render();

      wrap.querySelector(".tt-metrics__group-add").addEventListener("click", () => {
        if (!Array.isArray(this.data.metricGroups)) this.data.metricGroups = [];
        const fresh = normMetric({ match: "", color: this._pickFreeMetricColor() });
        this.data.metricGroups.push({ name: "", desc: "", items: [fresh] });
        this._saveMetrics();
        render(fresh);
      });
      return wrap;
    }

    /* 新指标 / 新大类的默认色：避开指标表里已经用掉的颜色（同 _pickFreeColor） */
    _pickFreeMetricColor() {
      const used = new Set(
        this._metrics().map((x) => String(x.metric.color || "").toLowerCase())
      );
      for (const c of PALETTE) {
        if (!used.has(c.toLowerCase())) return c;
      }
      return PALETTE[used.size % PALETTE.length] || DEFAULT_TYPE_COLOR;
    }

    /* ===================== 习惯分组管理 ===================== */

    /* 打开「习惯分组」弹窗：建组、改名、删组，把挑中的习惯点进 / 点出分组。
       骨架与类型管理共用 .tt-modal；列表短，不做拖拽。 */
    _openHabitGroupModal(onClose) {
      /* 同时只允许一个实例 */
      if (this._habitGroupModal) {
        this._habitGroupModal.remove();
        this._habitGroupModal = null;
      }
      const modal = document.createElement("div");
      modal.className = "tt-modal";
      modal.innerHTML = `
        <div class="tt-modal__backdrop"></div>
        <div class="tt-modal__panel">
          <div class="tt-modal__header">
            <span class="tt-modal__header-title">习惯分组</span>
            <button class="tt-modal__close" type="button" aria-label="关闭">×</button>
          </div>
          <div class="tt-modal__body"></div>
        </div>
      `;
      modal.querySelector(".tt-modal__body").appendChild(
        this._buildHabitGroupSettings()
      );

      const close = () => {
        document.removeEventListener("keydown", onKey, true);
        modal.remove();
        if (this._habitGroupModal === modal) this._habitGroupModal = null;
        /* 设置面板的门槛卡头部带着分组小标，关窗时刷新一份 */
        if (this._habitPickHost) this._mountHabitPicker(this._habitPickHost);
        if (typeof onClose === "function") {
          try {
            onClose();
          } catch (e) {
            console.warn(`${NAME}：习惯分组关闭回调失败`, e);
          }
        }
      };
      /* ESC 关闭（捕获阶段，免得被面板里的输入框吃掉） */
      const onKey = (e) => {
        if (e.key === "Escape") close();
      };
      document.addEventListener("keydown", onKey, true);

      modal.querySelector(".tt-modal__backdrop").addEventListener("click", close);
      modal.querySelector(".tt-modal__close").addEventListener("click", close);

      document.body.appendChild(modal);
      this._habitGroupModal = modal;
    }

    /* 构造习惯分组的管理面板：分组列表（名字 + 成员芯片）+ 添加分组。
       芯片直接复用习惯设置那套 .tt-habitpick__chip 样式，观感是一套的。 */
    _buildHabitGroupSettings() {
      const wrap = document.createElement("div");
      wrap.className = "tt-habgrp";
      wrap.innerHTML = `
        <div class="tt-habgrp__intro">把挑中的习惯归进同一个模块（比如「健康习惯」里放喝水、健身），习惯页会按分组分节展示。</div>
        <div class="tt-habgrp__groups"></div>
        <button class="tt-habgrp__add" type="button"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><use xlink:href="#iconAdd"></use></svg> 添加分组</button>
        <div class="tt-habgrp__hint">点习惯名把它收进 / 移出这个分组，一个习惯同时只属于一个分组。删掉的分组里成员自动回到未分组状态；没分组的习惯在习惯页里正常平铺、排在各分组后面。</div>
      `;
      const groupsEl = wrap.querySelector(".tt-habgrp__groups");

      const save = () => {
        this.data.habitGroups = this._habitGroupList();
        this._persist("保存习惯分组");
      };

      /* 单个分组盒子。name 是建盒那一刻的组名 —— 改名 / 删组后整列表重渲，
         闭包里的 name 永远和这份 DOM 对得上，不需要在原地追踪。 */
      const groupEl = (name) => {
        const el = document.createElement("div");
        el.className = "tt-habgrp__group";
        el.innerHTML = `
          <div class="tt-habgrp__head">
            <input type="text" class="tt-habgrp__name" placeholder="分组名" maxlength="20" />
            <span class="tt-habgrp__count"></span>
            <button class="tt-habgrp__remove" type="button" title="删除分组"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><use xlink:href="#iconMin"></use></svg></button>
          </div>
          <div class="tt-habgrp__desc">
            <input type="text" class="tt-habgrp__desc-input" placeholder="鼓励语 / 说明（可选），会显示在习惯页这个分组的标题旁" maxlength="60" />
          </div>
          <div class="tt-habgrp__members"></div>
        `;
        const nameInput = el.querySelector(".tt-habgrp__name");
        const countEl = el.querySelector(".tt-habgrp__count");
        const removeBtn = el.querySelector(".tt-habgrp__remove");
        const descInput = el.querySelector(".tt-habgrp__desc-input");
        const membersEl = el.querySelector(".tt-habgrp__members");
        nameInput.value = name;
        descInput.value = this._habitGroupDesc(name);

        /* 鼓励语：失焦 / 回车提交；清空 = 删掉这条说明 */
        descInput.addEventListener("change", () => {
          const v = String(descInput.value == null ? "" : descInput.value).trim();
          const descs = Object.assign({}, this.data.habitGroupDescs || {});
          if (v) descs[name] = v;
          else delete descs[name];
          this.data.habitGroupDescs = descs;
          save();
        });

        const habits = this._habitTypes();
        const memberNames = habits.filter((t) => this._habitGroupOf(t) === name);
        countEl.textContent = memberNames.length
          ? `${memberNames.length} 个习惯`
          : "暂无成员";

        /* 成员芯片：列出当前挑中的全部习惯，组内的亮着（显示别名，与习惯卡一致） */
        membersEl.innerHTML = habits.length
          ? habits
              .map((t) => {
                const color = this._colorOf(t) || DEFAULT_TYPE_COLOR;
                return `<button class="tt-habitpick__chip${
                  this._habitGroupOf(t) === name ? " on" : ""
                }" type="button" data-habgrp-member="${escapeHtml(t)}">
                    <span class="tt-habitpick__dot" style="background:${escapeHtml(color)}"></span>
                    <span class="tt-habitpick__name">${escapeHtml(
                      this._habitConfig(t).alias || t
                    )}</span>
                </button>`;
              })
              .join("")
          : '<span class="tt-habgrp__none">还没挑习惯 —— 先到「习惯设置 → 习惯类型」里点几个。</span>';

        membersEl.onclick = (e) => {
          const chip = e.target.closest && e.target.closest("[data-habgrp-member]");
          if (!chip) return;
          const type = chip.dataset.habgrpMember;
          /* 点亮 = 收进本组（_habitSetGroup 是整体覆盖，天然从别的组摘出）；
             再点一下 = 移出回「未分组」 */
          this._habitSetGroup(type, this._habitGroupOf(type) === name ? "" : name);
          save();
          render();
        };

        /* 改名：失焦 / 回车提交。组名是成员配置里的引用键，改名要同步所有成员 */
        nameInput.addEventListener("change", () => {
          const next = nameInput.value.trim();
          if (!next || next === name) {
            nameInput.value = name;
            return;
          }
          /* 与别的组撞名：不吞改动，恢复原名 */
          if (this._habitGroupList().indexOf(next) >= 0) {
            nameInput.value = name;
            return;
          }
          this.data.habitGroups = this._habitGroupList().map((n) =>
            n === name ? next : n
          );
          const cfgAll = this.data.habitConfig || {};
          Object.keys(cfgAll).forEach((t) => {
            if (cfgAll[t] && cfgAll[t].group === name) cfgAll[t].group = next;
          });
          /* 说明挂在组名这个键上，改名跟着搬；展开状态同理 */
          const descs = Object.assign({}, this.data.habitGroupDescs || {});
          if (descs[name] != null) {
            descs[next] = descs[name];
            delete descs[name];
          }
          this.data.habitGroupDescs = descs;
          const openMap = Object.assign({}, this.data.habitGroupExpanded || {});
          if (openMap[name] != null) {
            openMap[next] = openMap[name];
            delete openMap[name];
          }
          this.data.habitGroupExpanded = openMap;
          save();
          render();
        });

        removeBtn.addEventListener("click", () => {
          this.data.habitGroups = this._habitGroupList().filter((n) => n !== name);
          const cfgAll = this.data.habitConfig || {};
          Object.keys(cfgAll).forEach((t) => {
            if (cfgAll[t] && cfgAll[t].group === name) cfgAll[t].group = "";
          });
          const descs = Object.assign({}, this.data.habitGroupDescs || {});
          delete descs[name];
          this.data.habitGroupDescs = descs;
          const openMap = Object.assign({}, this.data.habitGroupExpanded || {});
          delete openMap[name];
          this.data.habitGroupExpanded = openMap;
          save();
          render();
        });

        return el;
      };

      const render = () => {
        groupsEl.innerHTML = "";
        this._habitGroupList().forEach((n) => groupsEl.appendChild(groupEl(n)));
      };

      wrap.querySelector(".tt-habgrp__add").addEventListener("click", () => {
        const existing = new Set(this._habitGroupList());
        let n = "新分组";
        for (let i = 2; existing.has(n); i++) n = `新分组${i}`;
        this.data.habitGroups = this._habitGroupList().concat(n);
        save();
        render();
      });

      render();
      return wrap;
    }

    /* 打开「设置」弹窗：把侧边栏 Dock 里的设置视图抽出来，做成截图那种
       「左侧导航 + 右侧内容」的原生设置版式（对齐思源设置弹窗的版式）。
       内容直接复用 _mountSettingsPanel()：它按 4 个分组构建 .tt-settings，
       这里按分组只显示其中一组；搜索时跨分组过滤行。

       层级刻意比类型管理弹窗（.tt-modal，9999）低 —— 设置里的「类型管理」
       按钮会在这个弹窗之上再开一层，不能被盖住。 */
    _openSettingsModal(groupKey) {
      /* 同时只允许一个实例 */
      if (this._settingsModal) {
        this._settingsModal.remove();
        this._settingsModal = null;
      }
      /* 左侧导航 = 右侧那五个分组本身，点某一项只显示该分组。
         key 必须与 _mountSettingsPanel 里 .tt-group__card 的 data-tt-group
         取值一一对应（insert / appearance / calendar / control / habit），
         对应关系是反查出来的，不依赖分组在 DOM 里的先后顺序。
         icon 一律用思源自带的图标 id（清单见 appearance/icons/<主题>/icon.js），
         写错 id 会渲染成一个空框。 */
      const GROUPS = [
        { key: "insert", label: "插入设置", icon: "iconEdit" },
        { key: "appearance", label: "视图外观", icon: "iconEye" },
        { key: "calendar", label: "日历设置", icon: "iconCalendar" },
        { key: "control", label: "控制设置", icon: "iconSettings" },
        { key: "habit", label: "习惯设置", icon: "iconStar" },
        { key: "metric", label: "指标设置", icon: "iconGraph" },
      ];
      const modal = document.createElement("div");
      modal.className = "tt-settings-modal";
      modal.innerHTML = `
        <div class="tt-settings-modal__backdrop"></div>
        <div class="tt-settings-modal__panel">
          <div class="tt-settings-modal__nav">
            <div class="tt-settings-modal__nav-title">
              <svg class="tt-settings-modal__nav-title-icon"><use xlink:href="#iconSettings"></use></svg>
              <span>设置</span>
            </div>
            <input class="tt-settings-modal__search" type="text" placeholder="搜索…" />
            <div class="tt-settings-modal__nav-list">
              ${GROUPS.map(
                (g, i) =>
                  `<button class="tt-settings-modal__navitem${
                    i === 0 ? " active" : ""
                  }" type="button" data-settings-group="${g.key}"><svg class="tt-settings-modal__navitem-icon"><use xlink:href="#${g.icon}"></use></svg><span>${g.label}</span></button>`
              ).join("")}
            </div>
          </div>
          <div class="tt-settings-modal__main">
            <div class="tt-settings-modal__body"></div>
          </div>
          <button class="tt-settings-modal__close" type="button" aria-label="关闭">✕</button>
        </div>
      `;
      const bodyEl = modal.querySelector(".tt-settings-modal__body");
      /* 复用设置面板内容（4 个 .tt-group，各自带标题 + 卡片） */
      this._mountSettingsPanel(bodyEl);

      const navItems = modal.querySelectorAll("[data-settings-group]");
      const searchEl = modal.querySelector(".tt-settings-modal__search");
      /* 打开时可以指定落到哪一分区：指标空态里的「去设置」直接落到「指标设置」，
         不必让用户再从第一页翻过去（传进来的 key 不合法就还是第一页） */
      let activeKey = GROUPS.some((g) => g.key === groupKey) ? groupKey : GROUPS[0].key;

      /* 切到某个分组：只显示它、其余整体隐藏。
         同时把可能被搜索改过的行显示状态恢复回来（搜索是按行打的 display:none）。 */
      const showGroup = (key) => {
        activeKey = key;
        bodyEl.querySelectorAll(".tt-row").forEach((r) => {
          r.style.display = "";
        });
        bodyEl.querySelectorAll(".tt-group").forEach((sec) => {
          const card = sec.querySelector("[data-tt-group]");
          const k = card ? card.getAttribute("data-tt-group") : "";
          sec.style.display = k === key ? "" : "none";
        });
        navItems.forEach((b) => {
          b.classList.toggle("active", b.getAttribute("data-settings-group") === key);
        });
      };
      showGroup(activeKey);

      /* 导航切换：清空搜索框（搜索态下点导航即视为退出搜索并直接切到该分组） */
      modal
        .querySelector(".tt-settings-modal__nav-list")
        .addEventListener("click", (e) => {
          const item = e.target.closest("[data-settings-group]");
          if (!item) return;
          if (searchEl) searchEl.value = "";
          showGroup(item.getAttribute("data-settings-group"));
        });

      /* 搜索：按标题 / 描述过滤行，命中的分组才显示；清空则回到当前分组 */
      if (searchEl) {
        searchEl.addEventListener("input", () => {
          const q = searchEl.value.trim().toLowerCase();
          if (!q) {
            showGroup(activeKey);
            return;
          }
          bodyEl.querySelectorAll(".tt-group").forEach((sec) => {
            let any = false;
            sec.querySelectorAll(".tt-row").forEach((row) => {
              const hit = row.textContent.toLowerCase().indexOf(q) >= 0;
              row.style.display = hit ? "" : "none";
              if (hit) any = true;
            });
            sec.style.display = any ? "" : "none";
          });
          navItems.forEach((b) => b.classList.remove("active"));
        });
      }

      const close = () => {
        document.removeEventListener("keydown", onKey, true);
        /* 取色面板挂在 body 上，不随弹窗一起销毁，得手动收掉 */
        if (typeof this._closeColorPicker === "function") this._closeColorPicker();
        modal.remove();
        if (this._settingsModal === modal) this._settingsModal = null;
        /* 设置里可能改过类型 / 颜色，关窗后重绘已打开的日历标签页 */
        this._refreshCalendarTabs();
      };
      /* ESC 关闭。类型管理弹窗可能叠在这层之上（设置里的「类型管理」按钮），
         那一下 ESC 交给它，避免一次按键把两层一起关掉。 */
      const onKey = (e) => {
        if (e.key !== "Escape") return;
        if (this._typesModal) return;
        close();
      };
      document.addEventListener("keydown", onKey, true);

      modal
        .querySelector(".tt-settings-modal__backdrop")
        .addEventListener("click", close);
      modal
        .querySelector(".tt-settings-modal__close")
        .addEventListener("click", close);

      document.body.appendChild(modal);
      this._settingsModal = modal;
    }

    /* ===================== 记录类型管理 ===================== */

    /* 取一个尚未在用户配置中出现过的调色板颜色，作为新建分组或类型的默认色 */
    _pickFreeColor() {
      const used = new Set();
      (this.data.typeGroups || []).forEach((g) => {
        if (g.color) used.add(g.color.toLowerCase());
        (g.items || []).forEach((i) => {
          if (i.color) used.add(i.color.toLowerCase());
        });
      });
      for (const c of PALETTE) {
        if (!used.has(c.toLowerCase())) return c;
      }
      const total = (this.data.typeGroups || []).reduce(
        (n, g) => n + 1 + (g.items || []).length,
        0
      );
      return PALETTE[total % PALETTE.length];
    }

    /* 类型 → 颜色；未收录使用默认灰 */
    _colorOf(type) {
      return this._typeColorOf(type) || DEFAULT_TYPE_COLOR;
    }

    /* 按名字在类型表里找颜色；**表里没有这个名字就返回空串**。
       单独拆出来是为了让调用方能区分「查不到」与「查到了、就是默认灰」：
       指标跟类型色这件事上，这个区别决定了「跟不跟」（见 _metricColorOf）。 */
    _typeColorOf(type) {
      const name = String(type == null ? "" : type).trim();
      if (!name) return "";
      for (const g of this.data.typeGroups || []) {
        const hit = (g.items || []).find(
          (i) => i.name === name && typeof i.color === "string" && i.color
        );
        if (hit) return hit.color;
      }
      return "";
    }

    /* 构造类型管理的设置面板：分组 + 分组描述 + 内联类型芯片 */
    _buildTypeSettings() {
      const wrap = document.createElement("div");
      wrap.className = "tt-types";
      wrap.innerHTML = `
        <div class="tt-types__intro">记录的类型，用于进行醒目提醒。主要分为四大类：</div>
        <div class="tt-types__groups"></div>
        <button class="tt-types__group-add" type="button"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><use xlink:href="#iconAdd"></use></svg> 添加分组</button>
        <button class="tt-types__reset" type="button">重置为默认</button>
        <div class="tt-types__hint">颜色变更会立即保存；旧记录的底色需重新执行「扫描并打标」才会刷新。</div>
      `;
      const groupsEl = wrap.querySelector(".tt-types__groups");

      /* 给 input 按字数设一个 size。宽度现在由样式表的网格布局接管
         （名字框 flex 撑满芯片中间那段、长了截成省略号），
         size 只影响「还没套上样式」的那一瞬，留着免得挤成一条。 */
      const fitInput = (input, min = 2) => {
        input.size = Math.max(min, (input.value || "").length);
      };

      /* 单个类型芯片 */
      const itemEl = (item, gIdx, iIdx) => {
        const el = document.createElement("div");
        el.className = "tt-types__item";
        el.innerHTML = `
          <button type="button" class="tt-types__item-color" title="点击选择颜色"></button>
          <input type="text" class="tt-types__item-name" placeholder="类型名" maxlength="20" />
          <button class="tt-types__item-remove" type="button" title="删除该类型"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><use xlink:href="#iconMin"></use></svg></button>
        `;
        const colorInput = el.querySelector(".tt-types__item-color");
        const nameInput = el.querySelector(".tt-types__item-name");
        const removeBtn = el.querySelector(".tt-types__item-remove");

        this._initColorPicker(colorInput, {
          color: item.color || DEFAULT_TYPE_COLOR,
          onChange: (hex) => {
            item.color = hex;
            this._saveTypes();
          },
        });
        nameInput.value = item.name || "";
        fitInput(nameInput, 4);

        nameInput.addEventListener("input", () => {
          item.name = nameInput.value.trim();
          fitInput(nameInput, 4);
          this._saveTypes();
        });
        removeBtn.addEventListener("click", () => {
          this.data.typeGroups[gIdx].items.splice(iIdx, 1);
          this._saveTypes();
          this._refreshTypeSettingsList();
        });
        return el;
      };

      /* 单个分组 */
      const groupEl = (group, gIdx) => {
        const el = document.createElement("div");
        el.className = "tt-types__group";
        el.innerHTML = `
          <div class="tt-types__group-head">
            <input type="text" class="tt-types__group-name" placeholder="分组名" maxlength="20" />
            <button type="button" class="tt-types__group-color" title="分组颜色"></button>
            <button class="tt-types__group-remove" type="button" title="删除分组"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><use xlink:href="#iconMin"></use></svg></button>
          </div>
          <div class="tt-types__group-desc">
            <input type="text" class="tt-types__group-desc-input" placeholder="分组描述" maxlength="120" />
          </div>
          <div class="tt-types__group-items"></div>
        `;
        const nameInput = el.querySelector(".tt-types__group-name");
        const colorInput = el.querySelector(".tt-types__group-color");
        const descInput = el.querySelector(".tt-types__group-desc-input");
        const removeBtn = el.querySelector(".tt-types__group-remove");
        const itemsEl = el.querySelector(".tt-types__group-items");

        nameInput.value = group.name || "";
        descInput.value = group.desc || "";
        nameInput.style.color = group.color || "var(--b3-theme-on-background)";
        fitInput(nameInput, 3);
        fitInput(descInput, 6);

        const applyGroupColor = () => {
          nameInput.style.color = group.color || "var(--b3-theme-on-background)";
        };

        /* 分组名文字跟着分组色走，改色时一并刷新 */
        this._initColorPicker(colorInput, {
          color: group.color || DEFAULT_TYPE_COLOR,
          onChange: (hex) => {
            group.color = hex;
            applyGroupColor();
            this._saveTypes();
          },
        });
        nameInput.addEventListener("input", () => {
          group.name = nameInput.value.trim();
          fitInput(nameInput, 3);
          this._saveTypes();
        });
        descInput.addEventListener("input", () => {
          group.desc = descInput.value.trim();
          fitInput(descInput, 6);
          this._saveTypes();
        });
        removeBtn.addEventListener("click", () => {
          this.data.typeGroups.splice(gIdx, 1);
          this._saveTypes();
          this._refreshTypeSettingsList();
        });

        /* 分组内「+」按钮 */
        const addBtn = document.createElement("button");
        addBtn.className = "tt-types__item-add";
        addBtn.type = "button";
        addBtn.title = "添加类型";
        addBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><use xlink:href="#iconAdd"></use></svg>';
        addBtn.addEventListener("click", () => {
          /* 新类型的颜色跟所属分组走：分组色缺失时用同一个兜底色
             （与分组色块的显示保持一致），不从调色板另取 ——
             那会出现「分组是灰的、新类型却是蓝的」这种对不上的情况。 */
          group.items.push({
            name: "",
            color: group.color || DEFAULT_TYPE_COLOR,
          });
          this._saveTypes();
          this._refreshTypeSettingsList();
        });
        itemsEl.appendChild(addBtn);

        group.items.forEach((item, iIdx) => {
          itemsEl.appendChild(itemEl(item, gIdx, iIdx));
        });

        return el;
      };

      const render = () => {
        groupsEl.innerHTML = "";
        this.data.typeGroups.forEach((g, i) => groupsEl.appendChild(groupEl(g, i)));
      };

      /* 暴露给删除按钮复用：重新渲染整个列表（避免 splice 后 index 漂移） */
      this._refreshTypeSettingsList = render;

      wrap.querySelector(".tt-types__group-add").addEventListener("click", () => {
        const color = this._pickFreeColor();
        this.data.typeGroups.push({
          name: "",
          color,
          desc: "",
          items: [],
        });
        this._saveTypes();
        render();
      });
      wrap.querySelector(".tt-types__reset").addEventListener("click", () => {
        this.data.typeGroups = DEFAULT_TYPE_GROUPS.map((g) => ({
          name: g.name,
          color: g.color,
          desc: g.desc,
          items: g.items.map((i) => ({ ...i })),
        }));
        this._saveTypes();
        render();
      });

      render();
      return wrap;
    }

    /* 插件数据统一落盘入口。
       写盘前会把「还没起名字的类型」剔掉 —— 那只是编辑过程中的占位，不该落库
       （这类空类型在下次启动时本来也会被丢掉，落库只会让磁盘数据比界面上更旧）。 */
    _persist(tag = "保存类型配置") {
      this._typesDirty = false;
      const groups = (this.data.typeGroups || []).map((g) => ({
        name: g.name,
        color: g.color,
        desc: g.desc,
        items: (g.items || [])
          .filter((i) => i && i.name)
          .map((i) => ({ name: i.name, color: i.color })),
      }));
      /* 指标表一起归一化后再落盘：没名字的指标（用户正在输入的中间态）会被丢掉，
         免得存进一份带空名的配置，下次打开弹窗多出一个无名卡片 */
      const metricGroups = normMetricGroups(this.data.metricGroups);
      this.saveData(
        DATA_KEY,
        Object.assign({}, this.data, { typeGroups: groups, metricGroups })
      ).catch((e) => console.warn(`${NAME}：${tag}失败`, e));
    }

    /* 把攒着的改动落盘（关窗、插件卸载时用）。
       没有攒下的改动就不写 —— 写盘会让思源重载插件，无谓地写会自己转圈。 */
    _flushTypes() {
      if (!this._typesDirty) return;
      this._persist("保存类型配置");
    }

    /* 类型表变更：只改内存，不写盘 —— 写 petal 文件会被思源侦测到并重载插件，
       编辑期间写盘会把当前这个弹窗直接打断。落盘统一推迟到关窗 / 插件卸载。
       样式与 Dock 用内存数据即时重绘，所以界面上的改动是立刻可见的。 */
    _saveTypes() {
      this._typesDirty = true;
      /* 类型配色变更后重建标记样式 */
      this._ensureMarkStyle();
      /* 类型颜色变更后，用缓存即时重绘 Dock 时间轴，让新颜色立即生效 */
      if (this._lifeLogDockEl && this._lifelogDockCache) {
        try {
          const listEl = this._lifeLogDockEl.querySelector("#north-lifelog-dock-list");
          if (listEl && listEl.style.display !== "none") {
            this._renderLifeLogDockList(listEl, this._lifelogDockCache);
          }
        } catch (e) {}
      }
    }

    /* scope 可选：传入设置容器时在该容器内找笔记本下拉（设置面板被「设置弹窗」
       设置面板仅用于设置弹窗，各自刷新各自的那一份，不互相抢 this.notebookCddl）。 */
    async _refreshNotebooks(scope) {
      const cddl =
        scope && typeof scope.querySelector === "function"
          ? scope.querySelector(".tt-cddl")
          : this.notebookCddl;
      if (!cddl) return;
      const popup = cddl.querySelector(".tt-cddl__popup");
      const valueEl = cddl.querySelector(".tt-cddl__value");
      if (!popup || !valueEl) return;
      const esc = (s) =>
        String(s).replace(
          /[&<>"']/g,
          (c) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
        );
      try {
        const resp = await this._request("/api/notebook/lsNotebooks", {});
        const notebooks =
          resp.data && Array.isArray(resp.data.notebooks)
            ? resp.data.notebooks
            : [];
        const current = (this.data.notebook || "").trim();
        const items = [
          { id: "", name: "请选择笔记本" },
          ...notebooks.map((nb) => ({
            id: nb.id,
            name: nb.closed ? `${nb.name}（已关闭）` : nb.name,
          })),
        ];
        popup.innerHTML = items
          .map(
            (o) =>
              `<div class="tt-cddl__item${o.id === current ? " active" : ""}" data-value="${esc(o.id)}">${esc(o.name)}</div>`
          )
          .join("");
        const cur = items.find((o) => o.id === current);
        valueEl.textContent = cur ? cur.name : "请选择笔记本";
      } catch (e) {
        console.warn(`${NAME}：读取笔记本列表失败`, e);
      }
    }

    _openSettings() {
      /* 设置现已统一为弹窗（左侧导航 + 右侧内容），不再依赖侧栏 Dock 页签 */
      this._openSettingsModal();
    }

    /* ============================================================
     * LifeLog Dock 侧边栏视图（1:1 复刻「轻语」）
     * - 页签：记录 / 统计；右侧工具：刷新
     * - 记录视图：周历条（本周）+ 时间轴 + 悬浮添加按钮
     * - 数据源：custom-<前缀>-* 块属性（轻迹自己的打标体系，前缀可在设置中自定义）
     * ============================================================ */

    /* 主题模式（明 / 暗），决定类型颜色文本钳制 */
    _themeMode() {
      const el = document.documentElement;
      return (el && el.getAttribute("data-theme-mode")) || "light";
    }

    /* 把 #rrggbb 转成 hsl 数组 */
    _hexToHsl(hex) {
      const m = String(hex || "").match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
      if (!m) return null;
      const r = parseInt(m[1], 16) / 255;
      const g = parseInt(m[2], 16) / 255;
      const b = parseInt(m[3], 16) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      let h = 0;
      let s = 0;
      const l = (max + min) / 2;
      const d = max - min;
      if (d !== 0) {
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
      }
      return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
    }

    /* 记录类型在 Dock 中的文本颜色：
       取 data.types 映射色，转 HSL 后按明暗主题钳制亮度，保证可读。 */
    _dockTypeColor(type) {
      if (!type) return "";
      const hex = this._colorOf(type) || DEFAULT_TYPE_COLOR;
      const hsl = this._hexToHsl(hex);
      if (!hsl) return hex;
      const maxL = this._themeMode() === "dark" ? 60 : 39;
      if (hsl[2] > maxL) hsl[2] = maxL;
      return `hsl(${hsl[0]}, ${hsl[1]}%, ${hsl[2]}%)`;
    }

    /* 把本地存储里那份 Dock 存档校正成当前代码里的样子：标题 + 快捷键。
       为什么需要：思源在 addPluginDock 里会拿 window.siyuan.storage["local-plugin-docks"]
       里已有的条目**整份覆盖** plugin.docks[key].config（见 app/src/plugin/loader.ts），
       本意是保住用户在界面上调过的位置 / 尺寸 / 显隐 —— 副作用是插件改过标题之后，
       老用户那边永远显示第一次注册时存下的旧名（轻迹曾叫「时迹」，就是这么被冻住的）。
       所以这里在 addDock **之前**校正内存里那份存档：只动 title 与 hotkey 两个字段，
       位置 / 尺寸 / 显隐原样保留，用户调过的面板状态不丢；也刻意不落盘
       （不写用户工作空间里的 local.json），每次启动校正一次即可，代价为零。
       时机很关键：addDock 跑完之后 config 已经被存档覆盖，那时候再改就晚了。 */
    _syncDockMeta() {
      try {
        const store = window.siyuan && window.siyuan.storage;
        const bucket = store && store["local-plugin-docks"];
        const mine = bucket && bucket[this.name];
        const rec = mine && mine[this.name + DOCK_TYPE];
        if (!rec) return;
        if (rec.title !== DOCK_TITLE) rec.title = DOCK_TITLE;
        /* 快捷键同理：存档里存的是第一次注册时的值（轻迹那份是空串），
           不校正的话 addPluginDock 会把它盖回 config.hotkey，面板那行就一直没有快捷键。 */
        if (rec.hotkey !== DOCK_HOTKEY) rec.hotkey = DOCK_HOTKEY;
      } catch (e) {
        console.warn(`${NAME}：校正 Dock 配置失败`, e);
      }
    }

    /* Dock 初始化：记录元素并渲染整块视图 */
    _initLifeLogDock(dock) {
      if (!dock || !dock.element) return;
      this._lifeLogDockEl = dock.element;
      this._dockActiveView = "records";
      /* 应用紧凑模式 class */
      this._applyDockCompact();
      this._renderLifeLogDockContent(dock.element);
      /* 应用「Dock 侧边栏显示」开关：插件注册时若默认关闭，立刻把入口藏掉 */
      this._applyDockVisibility();
    }

    /* 由「Dock 侧边栏显示」开关驱动：控制 LifeLog 在思源侧栏的入口（dock 栏按钮）。
       关键事实：addDock 返回的是描述对象 {id,config,model}，没有 show/hide 方法，
       所以这里直接操作 DOM —— 显隐侧栏 dock 栏按钮（.dock__item[data-type]）。

       **面板容器不在这里藏**（这里踩过坑）：思源切换面板显隐靠的是自己那层状态，
       压不过元素上的内联 `display:none`。一旦给 dock.element 写上内联隐藏，
       面板其实被打开了、却永远看不见 —— 表现出来就是「按快捷键没反应」。
       所以只藏入口按钮，面板的开合交给思源自己的开关（快捷键走的也是那一套）。 */
    _applyDockVisibility() {
      const type = this.name + DOCK_TYPE;
      const apply = () => {
        /* 侧栏 dock 栏上的入口按钮：隐藏后用户无法从侧栏打开本面板 */
        const btn = document.querySelector(
          '.dock__item[data-type="' + type + '"]'
        );
        if (btn) {
          btn.style.display = this.data.dockVisible ? "" : "none";
        }
      };
      apply();
      /* 兜底清一次旧版本留下的内联隐藏：老代码给面板写过 display:none，
         元素上还带着的话，面板照样出不来 */
      if (this._lifeLogDockEl && this._lifeLogDockEl.style.display === "none") {
        this._lifeLogDockEl.style.display = "";
      }
      /* 开关关闭时如果面板正开着，顺手收起它 —— 是「收起」而不是「藏起来」 */
      if (!this.data.dockVisible) this._collapseLifeLogDock();
      /* 侧栏按钮可能晚于 onLayoutReady 渲染，关闭状态下多试几帧兜底 */
      if (!this.data.dockVisible) {
        let tries = 0;
        const tick = () => {
          apply();
          if (tries++ < 30) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }
    }

    /* 收起侧栏的轻迹面板：只在它**确实展开着**的时候动手 ——
       否则这一下反而会把它打开。走思源自己的开关（跟快捷键同一套逻辑），
       不碰内联 display。 */
    _collapseLifeLogDock() {
      const el = this._lifeLogDockEl;
      if (!el || !el.getBoundingClientRect().width) return;
      const type = this.name + DOCK_TYPE;
      const btn = document.querySelector('.dock__item[data-type="' + type + '"]');
      if (btn) {
        btn.click();
        return;
      }
      try {
        const L =
          (window.siyuan && window.siyuan.layout) ||
          (this.app && this.app.layout);
        if (!L) return;
        for (const area of [L.leftDock, L.rightDock, L.bottomDock]) {
          if (area && area.data && area.data[type]) {
            area.toggleModel(type, false, false);
            return;
          }
        }
      } catch (e) {}
    }

    /* 把「Dock 栏紧凑模式」状态反映到 dock 根元素 class 上。
       类名必须与 index.css 末尾「Dock 紧凑模式（最终覆盖）」一致：
       .north-luna-lifelog-dock-root.north-lifelog-dock-compact 下的全部规则。
       根元素同时带 north-luna-lifelog-dock-root，因此选择器用 3 个类，
       才能稳定压过前面那些 2 个类的基础覆盖规则。 */
    _applyDockCompact() {
      if (!this._lifeLogDockEl) return;
      this._lifeLogDockEl.classList.toggle(
        "north-lifelog-dock-compact",
        !!this.data.dockCompact
      );
    }

    /* 渲染 Dock 主体（页签 + 周历 + 时间轴 + 统计 + FAB + 弹层） */
    _renderLifeLogDockContent(root) {
      if (!root) return;
      root.classList.add("fn__flex-1", "fn__flex-column", "north-luna-lifelog-dock-root");
      root.innerHTML = `<div class="fn__flex-1 fn__flex-column north-lifelog-dock-body">
            <div class="north-lifelog-dock-header">
                <div class="north-lifelog-dock-tabs">
                    <button class="north-lifelog-dock-tab active" data-dock-tab="records" id="lifelog-dock-tab-records">记录</button>
                    <button class="north-lifelog-dock-tab" data-dock-tab="stats" id="lifelog-dock-tab-stats">统计</button>
                    <button class="north-lifelog-dock-tab" id="lifelog-dock-open-calendar" data-tip="在标签页中打开日历">日历</button>
                </div>
                <div class="north-lifelog-dock-tools">
                    <button class="north-lifelog-dock-refresh" id="north-lifelog-dock-refresh" data-tip="刷新">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><use xlink:href="#iconRefresh"></use></svg>
                    </button>
                </div>
            </div>
            <div class="north-lifelog-calendar-week-strip" id="lifelog-dock-week-strip"></div>
            <div class="fn__flex-1 north-lifelog-timeline" id="north-lifelog-dock-list">
                <div class="north-lifelog-timeline-empty">加载中…</div>
            </div>
            <div class="fn__flex-1 north-lifelog-dock-stats" id="north-lifelog-dock-stats" style="display:none"></div>
            <button class="north-lifelog-dock-fab" id="lifelogDockFab" data-tip="添加记录">
                <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><use xlink:href="#iconAdd"></use></svg>
            </button>
            <div class="north-lifelog-pick-overlay" id="lifelogDockPickOverlay" style="display:none">
                <div class="north-lifelog-pick-bg"></div>
                <div class="north-lifelog-pick-panel" id="lifelogDockPickPanel">
                    <div class="north-lifelog-pick-title">选择类型</div>
                    <div class="north-lifelog-pick-types" id="lifelogDockPickTypes"></div>
                    <button class="north-lifelog-pick-close" id="lifelogDockPickClose">取消</button>
                </div>
            </div>
            <div class="north-lifelog-input-modal" id="lifelogDockInputModal" style="display:none">
                <div class="north-lifelog-input-modal-bg"></div>
                <div class="north-lifelog-input-modal-body">
                    <div class="north-lifelog-input-modal-header">
                        <span class="north-lifelog-input-modal-type" id="lifelogDockInputModalType"></span>
                        <span class="north-lifelog-input-modal-time" id="lifelogDockInputModalTime"></span>
                    </div>
                    <textarea class="north-lifelog-input-modal-textarea" id="lifelogDockInputModalTextarea" placeholder="输入内容..." rows="3"></textarea>
                    <div class="north-lifelog-input-modal-actions">
                        <button class="north-lifelog-input-modal-back" id="lifelogDockInputModalBack">返回</button>
                        <button class="north-lifelog-input-modal-cancel" id="lifelogDockInputModalCancel">取消</button>
                        <button class="north-lifelog-input-modal-submit" id="lifelogDockInputModalSubmit">记录</button>
                    </div>
                </div>
            </div>
        </div>`;

      /* 按当前状态统一排布各面板显隐 */
      this._layoutLifeLogDock(root);
      /* 渲染周历条并绑定点击 */
      this._renderLifeLogDockCalendar(root);
      this._bindLifeLogDockCalendar(root);
      /* 悬浮提示：替掉日历格 / 热力图 / 日历按钮上的原生 title */
      this._bindDockTooltip(root);
      /* 加载数据并渲染 */
      this._refreshLifeLogDockContent();
      /* 绑定刷新按钮 */
      const refreshBtn = root.querySelector("#north-lifelog-dock-refresh");
      if (refreshBtn) {
        refreshBtn.addEventListener("click", () => {
          this._refreshLifeLogDockContent(true);
          if (this._dockActiveView === "stats") this._renderLifeLogDockStats(root);
        });
      }
      /* 绑定顶部页签切换（记录 / 统计）。
         「日历」不参与 Dock 内部切换 —— 它是打开思源标签页的入口，
         因此不带 data-dock-tab，在这里被 if (!target) 跳过。 */
      const tabs = root.querySelectorAll(".north-lifelog-dock-tab");
      tabs.forEach((tab) => {
        tab.addEventListener("click", () => {
          const target = tab.dataset.dockTab;
          if (!target) return;
          /* 已经停留在该页时无需重渲染 */
          if (target === this._dockActiveView) return;
          this._dockActiveView = target;
          this._layoutLifeLogDock(root);
          if (target === "stats") this._renderLifeLogDockStats(root);
        });
      });
      /* 「日历」：在思源标签页里打开日历视图 */
      const openCalBtn = root.querySelector("#lifelog-dock-open-calendar");
      if (openCalBtn) {
        openCalBtn.addEventListener("click", () => this._openCalendarTab());
      }
      /* 绑定 Dock 悬浮添加按钮点击 */
      this._bindLifeLogDockFabClick(root);
    }

    /* 按 _dockActiveView 统一排布面板显隐 */
    _layoutLifeLogDock(root) {
      const records = this._dockActiveView === "records";
      const stats = this._dockActiveView === "stats";
      const strip = root.querySelector("#lifelog-dock-week-strip");
      const listEl = root.querySelector("#north-lifelog-dock-list");
      const statsEl = root.querySelector("#north-lifelog-dock-stats");
      const fab = root.querySelector("#lifelogDockFab");
      const tabs = root.querySelectorAll(".north-lifelog-dock-tab");
      if (strip) strip.style.display = records ? "" : "none";
      if (listEl) listEl.style.display = records ? "" : "none";
      if (statsEl) statsEl.style.display = stats ? "" : "none";
      if (fab) fab.style.display = records ? "" : "none";
      tabs.forEach((t) => {
        const on = t.dataset.dockTab === this._dockActiveView;
        t.classList.toggle("active", !!on);
      });
    }

    /* 记录数据发生变化后的统一收口：作废缓存，并把 Dock 与已打开的日历标签页重绘一遍。
       调用点都挂在「块属性确实被写入 / 更新」之后，所以这里不需要再判断有没有变化。
       打标走 600ms 防抖，连续敲几行会连着来，因此这里再做一层节流 ——
       只在停手后刷一次，既保证「写完就能看到」，也不至于每敲一下就重查一遍数据库。 */
    _notifyRecordsChanged() {
      this._lifelogDockCache = null;
      this._lifelogDockCacheTime = 0;
      if (this._recordsRefreshTimer) clearTimeout(this._recordsRefreshTimer);
      this._recordsRefreshTimer = setTimeout(() => {
        this._recordsRefreshTimer = null;
        /* Dock 没渲染时内部会直接返回，不会白跑查询 */
        this._refreshLifeLogDockContent(true);
        /* 日历在主区域，和 Dock 是否渲染无关，单独照顾一次 */
        this._refreshCalendarTabs();
      }, 300);
    }

    /* 光标是不是还停在这个段落里 —— 用来判断用户是否还在这行上打字 */
    _isEditingParagraph(p) {
      if (!p || typeof p.contains !== "function") return false;
      const sel =
        typeof window !== "undefined" && window.getSelection ? window.getSelection() : null;
      if (!sel || !sel.anchorNode) return false;
      const node = sel.anchorNode;
      const el = node.nodeType === 1 ? node : node.parentElement;
      return !!(el && p.contains(el));
    }

    /* 光标离开后把挂起的侧栏刷新补上。
       用户还在这一行上打字时先不刷列表：内容会随每次停顿变一遍、跟着刷一遍，
       列表中间又会出现「加载中…」，看起来就是一闪一闪。
       集合里只要还剩光标停着的行就继续等，全部离开了才刷一次。 */
    _flushPendingRefreshes() {
      if (!this._pendingRefreshParas || this._pendingRefreshParas.size === 0) return;
      const pending = Array.from(this._pendingRefreshParas);
      this._pendingRefreshParas.clear();
      let stillEditing = false;
      pending.forEach((p) => {
        if (this._isEditingParagraph(p)) {
          this._pendingRefreshParas.add(p);
          stillEditing = true;
        }
      });
      if (stillEditing) return;
      this._notifyRecordsChanged();
    }

    /* 加载 LifeLog 数据并刷新 Dock 时间轴列表（30 秒缓存） */
    async _refreshLifeLogDockContent(forceRefresh = false) {
      const root = this._lifeLogDockEl;
      if (!root) return;
      const listEl = root.querySelector("#north-lifelog-dock-list");
      if (!listEl) return;
      const now = Date.now();
      if (!forceRefresh && this._lifelogDockCache && this._lifelogDockCacheTime && now - this._lifelogDockCacheTime < 30000) {
        this._renderLifeLogDockList(listEl, this._lifelogDockCache);
        return;
      }
      /* 清除日期筛选并重绘周历条 */
      this._lifelogDockDateFilter = null;
      this._renderLifeLogDockCalendar(root);
      /* 列表已经有内容就先留着，等查询回来直接替换 ——
         中间插一段「加载中…」会闪白，短查询反而更晃眼。 */
      if (!listEl.querySelector(".north-lifelog-timeline-item")) {
        listEl.innerHTML = '<div class="north-lifelog-timeline-empty">加载中…</div>';
      }
      try {
        const records = await this._queryLifeLogDockRecords();
        this._lifelogDockCache = records || [];
        this._lifelogDockCacheTime = Date.now();
        this._renderLifeLogDockList(listEl, this._lifelogDockCache);
        /* 日历标签页也用这份缓存，顺手把它一起重绘（上面刚赋值，不会重复查询）。
           数据源选「创建的文档」时，日历会去查文档那份数据，这里同样不白跑。 */
        this._refreshCalendarTabs();
      } catch (e) {
        console.warn(`${NAME}：Dock 数据加载失败`, e);
        listEl.innerHTML = '<div class="north-lifelog-timeline-empty">加载失败，请重试</div>';
      }
    }

    /* 查询当前前缀的打标记录（上限 CAL_RECORDS_LIMIT 条，足够覆盖全部历史）
       前缀已在 normAttrPrefix 中白名单过滤，仅含小写字母、数字与连字符。 */
    async _queryLifeLogDockRecords() {
      const records = [];
      try {
        const aDate = this._attr("date");
        const aTime = this._attr("time");
        const aType = this._attr("type");
        const aContent = this._attr("content");
        /* rb 是记录所在的那篇**文档**（记录都住在当天的日记文档里）。
           只多读 content 与 ial 两列：content 当文档标题、ial 里抠文档图标，
           表格视图的「日期带」要用图标颜色上色（icon 取色走 _iconColorOf）。
           LEFT JOIN 是必须的 —— 万一某条记录的 root_id 不指向文档也不会漏掉记录。 */
        const sql = `SELECT b.id, b.content, b.root_id,
                            rb.content AS tt_doc,
                            rb.ial AS tt_ial,
                            a1.value AS tt_date,
                            a2.value AS tt_time,
                            a3.value AS tt_type,
                            a4.value AS tt_content
                     FROM blocks b
                     INNER JOIN attributes a1 ON b.id = a1.block_id AND a1.name = '${aDate}'
                     INNER JOIN attributes a2 ON b.id = a2.block_id AND a2.name = '${aTime}'
                     INNER JOIN attributes a3 ON b.id = a3.block_id AND a3.name = '${aType}'
                     INNER JOIN attributes a4 ON b.id = a4.block_id AND a4.name = '${aContent}'
                     LEFT JOIN blocks rb ON rb.id = b.root_id
                     WHERE b.type = 'p'
                     ORDER BY a1.value DESC, a2.value DESC, b.id
                     LIMIT ${CAL_RECORDS_LIMIT}`;
        const resp = await this._request("/api/query/sql", { stmt: sql });
        if (resp.code !== 0 || !Array.isArray(resp.data)) return records;
        for (const row of resp.data) {
          /* 文档图标在 ial 里：icon="1f4d5"（内置 emoji 码位）或 icon="material/xx.svg" */
          const im = String(row.tt_ial || "").match(/icon="([^"]+)"/);
          records.push({
            id: `lifelog_dock_${row.id}`,
            content: (row.tt_content || row.content || "").trim(),
            date: (row.tt_date || "").trim().replace(/\//g, "-"),
            time: (row.tt_time || "").trim(),
            type: (row.tt_type || "").trim(),
            /* 刻意不叫 icon / color：那两个字段表示「记录自己的」图标与颜色，
               _iconHint() 与 _calRecordColor() 都会读它们；这里装的是「记录所在文档的」，
               混用会让每条记录的悬停气泡都多出一个文档表情、还会把记录的类型色顶掉。
               表格视图的日期带只认 docColor，其它视图不受影响。 */
            docIcon: im ? im[1] : "",
            docTitle: String(row.tt_doc || "").trim(),
            docColor: "",
          });
        }
        /* 文档图标颜色要读像素，异步。同一批里重复的图标只算一次（_iconColorOf 内部还有缓存） */
        const icons = Array.from(
          new Set(records.map((r) => r.docIcon).filter(Boolean))
        );
        await Promise.all(icons.map((ic) => this._iconColorOf(ic)));
        records.forEach((r) => {
          r.docColor = r.docIcon ? this._calIconColors.get(r.docIcon) || "" : "";
        });
      } catch (e) {
        console.warn(`${NAME}：Dock 查询失败`, e);
      }
      return records;
    }

    /* ============================================================
     * 日历区：折叠态为本周周历条，展开态为整月月历
     * ============================================================ */

    /* 日历日期键：YYYY-MM-DD */
    _calKey(d) {
      return (
        d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0")
      );
    }

    /* 一周的起始列：0 为周日、1 为周一。
       配置里 weekStart 为 0 时按周日起，其余情况沿用周一开头，
       这样折叠态周历条与展开态月历的首列始终一致。 */
    _calWeekStart() {
      return Number(this.data && this.data.weekStart) === 0 ? 0 : 1;
    }

    /* 星期表头文字，索引与 grid 首列对应 */
    _calWeekNames(ws) {
      return ws === 1
        ? ["一", "二", "三", "四", "五", "六", "日"]
        : ["日", "一", "二", "三", "四", "五", "六"];
    }

    /* 农历换算：返回 { year, month, day, isLeap }，超出可算范围返回 null。
       算法与轻语 getLunarDate 一致，共用上方 LUNAR_DATA 压缩表。 */
    _getLifelogLunarDate(date) {
      const y = date.getFullYear();
      if (y < LUNAR_MIN_YEAR || y > LUNAR_MAX_YEAR) return null;
      const yearDays = (year) => {
        let sum = 348;
        for (let i = 0x8000; i > 0x8; i >>= 1) {
          sum += LUNAR_DATA[year - 1900] & i ? 1 : 0;
        }
        const leap = LUNAR_DATA[year - 1900] & 0xf;
        return sum + (leap ? (LUNAR_DATA[year - 1900] & 0x10000 ? 30 : 29) : 0);
      };
      const leapMonthOfYear = (year) => LUNAR_DATA[year - 1900] & 0xf;
      const monthDays = (year, month) => (LUNAR_DATA[year - 1900] & (0x10000 >> month) ? 30 : 29);
      const baseDate = new Date(LUNAR_MIN_YEAR, 0, 31);
      let offset = Math.floor((date - baseDate) / 86400000);
      let lunarYear = LUNAR_MIN_YEAR;
      let daysInYear = 0;
      for (let i = LUNAR_MIN_YEAR; i < LUNAR_MAX_YEAR && offset > 0; i++) {
        daysInYear = yearDays(i);
        offset -= daysInYear;
        lunarYear++;
      }
      if (offset < 0) {
        offset += daysInYear;
        lunarYear--;
      }
      const leapMonth = leapMonthOfYear(lunarYear);
      let isLeap = false;
      let lunarMonth = 1;
      let daysInMonth = 0;
      let i = 1;
      for (i = 1; i < 13 && offset > 0; i++) {
        if (leapMonth > 0 && i === leapMonth + 1 && !isLeap) {
          i--;
          isLeap = true;
          daysInMonth = LUNAR_DATA[lunarYear - 1900] & 0x10000 ? 30 : 29;
        } else {
          daysInMonth = monthDays(lunarYear, i);
        }
        offset -= daysInMonth;
        if (!isLeap) lunarMonth++;
        else isLeap = false;
      }
      if (offset === 0 && leapMonth > 0 && i === leapMonth + 1) {
        if (isLeap) {
          isLeap = false;
        } else {
          isLeap = true;
          lunarMonth--;
        }
      }
      if (offset < 0) {
        offset += daysInMonth;
        lunarMonth--;
      }
      return { year: lunarYear, month: lunarMonth, day: offset + 1, isLeap: isLeap };
    }

    /* 农历月名格式化，闰月前缀「闰」 */
    _formatLifelogLunarMonth(month, isLeap) {
      const name = LUNAR_MONTH_NAMES[month - 1];
      if (!name) return "";
      return (isLeap ? "闰" : "") + name + "月";
    }

    /* 某年第 n 个节气（0 为小寒）落在公历几号。
       采用常用的近似算法：以 1900-01-06 02:05 为基准叠加回归年长度与节气偏移，
       在 1900-2049 区间内与常见历书结果一致，个别年份可能有一日误差。 */
    _solarTermDay(year, n) {
      const base = Date.UTC(1900, 0, 6, 2, 5);
      const ms = 31556925974.7 * (year - 1900) + SOLAR_TERM_INFO[n] * 60000;
      return new Date(base + ms).getUTCDate();
    }

    /* 当天是否为某个节气，是则返回节气名，否则返回空串 */
    _getSolarTermName(date) {
      const y = date.getFullYear();
      if (y < LUNAR_MIN_YEAR || y > LUNAR_MAX_YEAR) return "";
      const m = date.getMonth();
      const d = date.getDate();
      const a = m * 2;
      if (this._solarTermDay(y, a) === d) return SOLAR_TERM_NAMES[a];
      const b = a + 1;
      if (this._solarTermDay(y, b) === d) return SOLAR_TERM_NAMES[b];
      return "";
    }

    /* 日历格副文本，优先级：公历节日 > 农历节日 > 节气 > 农历月首 > 农历日。
       festival 为 true 时在月历中用强调色显示，
       折叠态周历条不使用本方法，仍只显示公历节日，保持原有观感。 */
    /* 日历格副标题。
       返回 { text, festival, kind }：
       festival 供 Dock 月历判红字（沿用旧字段），
       kind 供日历标签页细分颜色：holiday 节日 / term 节气 / lunar-month 农历月首 / lunar 农历日。 */
    _getLifelogCalendarSubtext(date) {
      const solarHoliday = SOLAR_HOLIDAYS[date.getMonth() + 1 + "-" + date.getDate()] || "";
      if (solarHoliday) return { text: solarHoliday, festival: true, kind: "holiday" };
      const lunar = this._getLifelogLunarDate(date);
      if (lunar) {
        const lunarHoliday = LUNAR_HOLIDAYS[lunar.month + "-" + lunar.day] || "";
        if (lunarHoliday) return { text: lunarHoliday, festival: true, kind: "holiday" };
      }
      const term = this._getSolarTermName(date);
      if (term) return { text: term, festival: true, kind: "term" };
      if (lunar) {
        if (lunar.day === 1) {
          return {
            text: this._formatLifelogLunarMonth(lunar.month, lunar.isLeap),
            festival: true,
            kind: "lunar-month",
          };
        }
        return { text: LUNAR_DAY_NAMES[lunar.day - 1] || "", festival: false, kind: "lunar" };
      }
      return { text: "", festival: false, kind: "" };
    }

    /* ISO 周序号：周一为一周之始，含当年第一个周四的那一周记为第 1 周。
       与日历软件、ISO 8601 的周编号口径一致。 */
    _calWeekNumber(date) {
      const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const day = d.getDay() === 0 ? 7 : d.getDay();
      d.setDate(d.getDate() + 4 - day);
      const yearStart = new Date(d.getFullYear(), 0, 1);
      return Math.floor(Math.round((d - yearStart) / 86400000) / 7) + 1;
    }

    /* 日历当前的数据源（设置里选的） */
    _calSource() {
      return normCalSource(this.data && this.data.calendarSource);
    }

    /* 记录的量词。数据源换成「创建的文档」之后，再说「条记录」就不对了 */
    _calUnit() {
      return this._calSource() === "docs" ? "篇文档" : "条记录";
    }

    /* 时间轴视图的三个显示开关，一律默认关闭（不勾选 = 保持素色原样）：
       - calTextColor：记录文字按类型色着色（关 = 标题用正文色、时间用三级文字色）
       - calShowType：标题写成「类型 | 内容」（关 = 只显示内容）
       - calShowIcon：时间前面挂一枚表针图标
       三个都只作用于周 / 三日 / 日这三个共用结构的视图，月视图与当天详情列表不受影响。 */
    _calTextColor() {
      return !!(this.data && this.data.calTextColor);
    }
    _calShowType() {
      return !!(this.data && this.data.calShowType);
    }
    _calShowIcon() {
      return !!(this.data && this.data.calShowIcon);
    }

    /* 日历当前数据源的那份数组。
       **所有视图都从这里取数**，所以换数据源时视图层一行都不用改。 */
    _calSourceRecords() {
      return (this._calSource() === "docs" ? this._calDocsCache : this._lifelogDockCache) || [];
    }

    /* 把 [{date, ...}] 按日期分桶 */
    _groupByDate(list) {
      const byDate = {};
      (list || []).forEach((r) => {
        if (!r || !r.date) return;
        if (!byDate[r.date]) byDate[r.date] = [];
        byDate[r.date].push(r);
      });
      return byDate;
    }

    /* **Dock 那套日历专用**：永远只看 LifeLog 记录。
       设置里的「日历数据源」只作用于日历标签页 —— 这里要是也跟着变，
       Dock 会出现「月历显示文档、下面的记录列表显示记录」这种自相矛盾的状态。 */
    _calRecordsByDate() {
      return this._groupByDate(this._lifelogDockCache);
    }

    /* 日历标签页里真正参与展示的记录：按工具栏选中的类型筛过。
       筛选为空表示「全部类型」—— 这也是默认值，此时原样返回，不做任何过滤。 */
    _calTabFilteredRecords() {
      const all = this._calSourceRecords() || [];
      const picked = this._calTabTypeFilter;
      if (!picked || picked.size === 0) return all;
      return all.filter((r) => r && picked.has(((r && r.type) || "").trim()));
    }

    /* 筛选面板里能选的类型：取日历数据里**实际出现过**的类型，带各自配色。
       只列出现过的 —— 选一个一条记录都没有的类型没有意义。
       数据还没加载完时退回配置里的全部类型，免得面板空着。 */
    _calTabTypeOptions(records) {
      const count = new Map();
      /* 默认用当前「日历数据源」的记录；指标视图会把它自己那份记录传进来 ——
         指标固定读记录（不看数据源设置），筛选项也得跟着同一份数据，否则出现
         「筛选项里有、指标上却筛不出」的错位 */
      (Array.isArray(records) ? records : this._calSourceRecords() || []).forEach((r) => {
        const t = ((r && r.type) || "").trim();
        if (t) count.set(t, (count.get(t) || 0) + 1);
      });
      let names = Array.from(count.keys()).sort();
      if (!names.length) names = this._dockPickTypes();
      return names.map((name) => ({
        name,
        color: this._colorOf(name) || DEFAULT_TYPE_COLOR,
      }));
    }

    /* 筛选按钮上的文案：没筛就是「全部类型」，只筛一个就直接显示类型名 */
    _calTabFilterLabel() {
      const picked = this._calTabTypeFilter;
      if (!picked || picked.size === 0) return "全部类型";
      if (picked.size === 1) return Array.from(picked)[0];
      return `${picked.size} 个类型`;
    }

    /* 日历标签页用：按设置里的数据源归组，再过一遍类型筛选。
       两种数据源的记录是同构的（date / time / type / content），所以不用分支。 */
    _calTabRecordsByDate() {
      return this._groupByDate(this._calTabFilteredRecords());
    }

    /* 日期格悬浮提示：完整日期 + 星期 + 当天条数。
       unit 省略时按「条记录」算（Dock 那套月历走默认值，它只有记录这一种数据）；
       两种量词都固定是「X记录 / X文档」两字后缀，空态直接切掉首字即可。 */
    _calDayTitle(d, count, unit) {
      const wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
      const label = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${wd}`;
      const u = unit || "条记录";
      return count > 0 ? `${label} · ${count} ${u}` : `${label} · 暂无${u.slice(1)}`;
    }

    /* ============================================================
     * 时间轴视图（周 / 三日）
     * 左时间刻度 + N 天列，记录按时间比例摆成块。
     * 与月视图共用同一份数据、同一套配色（左侧短色条 + 14% 同色淡底），
     * 差别只在「一行一条胶囊」换成「按时间比例摆的块」。
     * 周与三日只有「列数 / 起点」不同，排版与尺寸全是同一份实现。
     * ============================================================ */

    /* 从记录的 time 文本里取时间区间，单位是「当天第几分钟」。
       我们的记录基本都是时间点（08:30 类型：内容），所以多半只有 start；
       万一有人把 time 手改成 08:30 - 09:30 这种区间，也一并接住。
       取不到合法时间返回 null —— 这类记录在周视图里不显示，月视图仍然看得到。 */
    _parseTimeRange(str) {
      const hits = String(str == null ? "" : str).match(/(\d{1,2}):(\d{2})/g);
      if (!hits || !hits.length) return null;
      const toMin = (s) => {
        const p = String(s).split(":");
        const h = Number(p[0]);
        const mi = Number(p[1]);
        if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59)) return null;
        return h * 60 + mi;
      };
      const start = toMin(hits[0]);
      if (start === null) return null;
      const end = hits.length > 1 ? toMin(hits[1]) : null;
      /* 结束不晚于开始（时间写反 / 同一分钟）时当作没有结束时间，
         交给「接下一条」的兜底逻辑处理 */
      return { start, end: end === null || end <= start ? null : end };
    }

    /* 分钟数 → HH:MM */
    _fmtMin(min) {
      return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
    }

    /* 锚点所在那一周的起点日期（按用户配置的每周起始日）。
       偏移算法与 _buildCalendarMonthHtml 里的 lead 完全一致，
       所以周视图的第一列和月视图的第一列永远是同一天。 */
    _calTabWeekStartDate(anchor) {
      const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
      const ws = this._calWeekStart();
      const lead = ws === 1 ? (d.getDay() === 0 ? 6 : d.getDay() - 1) : d.getDay();
      d.setDate(d.getDate() - lead);
      return d;
    }

    /* 月视图当前停在的月份。
       与 _calTabAnchor（焦点日）**分开存**是刻意的：在月视图里滚动只是「翻看」，
       不该把周 / 三日 / 日视图的焦点日一起带走，反过来时间轴视图翻页也不该改变
       月视图停在哪儿。两者混用一个状态时踩过坑 —— 滚完月视图再点「周」，
       显示的不是本周（锚点被月视图改成了别的月份的 1 号）。
       没设过时退回焦点日，所以从时间轴视图切回月视图，月份跟得上。 */
    _calMonthAnchor() {
      if (this._calTabMonth instanceof Date) return this._calTabMonth;
      return this._calTabAnchor instanceof Date ? this._calTabAnchor : new Date();
    }

    /* 时间轴视图要显示的日期序列（周 / 三日 / 日共用）。
       三档的区别只有「几天」和「起点在哪」，所以写成三个明确分支而不是嵌套三元：
         周 —— 对齐到周首，整周 7 天，第一列与月视图一致；
         三日 —— 从锚点前一天起 3 天，锚点**居中**（昨天 / 今天 / 明天）；
         日 —— 就是锚点当天。
       三日为什么不让锚点排第一：这是记录工具，未来那两天基本是空的，
       全堆在后面看着像坏了。想改成「从锚点起三天」，把 -1 改成 0 即可。
       三档都是「包含锚点的窗口」，跟「今天」按钮的行为对得上。 */
    _calTimelineDays(anchor, view) {
      const base = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
      let count;
      let start;
      if (view === "week") {
        count = 7;
        start = this._calTabWeekStartDate(anchor);
      } else if (view === "three") {
        count = 3;
        start = new Date(base.getFullYear(), base.getMonth(), base.getDate() - 1);
      } else {
        count = 1;
        start = base;
      }
      const days = [];
      for (let i = 0; i < count; i++) {
        days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
      }
      return days;
    }

    /* 时间轴视图的标题：这一段是几天就列几天的起止。跨年时右侧也写全年份。
       只有一天时不写成「9月11日 – 9月11日」，改成带上星期 ——
       日视图里标题就是唯一的信息来源，星期比重复一遍日期有用。 */
    _calRangeTitle(start, count) {
      if (count === 1) {
        const wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][
          start.getDay()
        ];
        return `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日 ${wd}`;
      }
      const e = new Date(start.getFullYear(), start.getMonth(), start.getDate() + count - 1);
      const left = `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日`;
      const right =
        e.getFullYear() === start.getFullYear()
          ? `${e.getMonth() + 1}月${e.getDate()}日`
          : `${e.getFullYear()}年${e.getMonth() + 1}月${e.getDate()}日`;
      return `${left} – ${right}`;
    }

    /* 翻页箭头的提示语：跟着视图走，周视图里说「上个月」就串了 */
    _calStepTip(view, dir) {
      const before = dir === "prev";
      if (view === "stats") {
        const p = this._calTabStatsPeriod || "year";
        if (p === "week") return before ? "上一周" : "下一周";
        if (p === "year") return before ? "上一年" : "下一年";
        return before ? "上个月" : "下个月";
      }
      /* 指标视图按「查看范围」的步长挪窗口，提示语就把步长写出来 */
      if (view === "metric") {
        const days = parseInt(this._calTabMetricScope, 10);
        const n = Number.isFinite(days) && days > 0 ? days : 30;
        return before ? `往前 ${n} 天` : `往后 ${n} 天`;
      }
      if (view === "week") return before ? "上一周" : "下一周";
      /* 习惯视图按自己选的周期翻：日 / 周 / 月 / 范围各有各的步长，
         年就是原来的行为（翻整年） */
      if (view === "habit") {
        const p = this._calTabHabitPeriod || "year";
        if (p === "day") return before ? "前一天" : "后一天";
        if (p === "week") return before ? "上一周" : "下一周";
        if (p === "month") return before ? "上个月" : "下个月";
        if (p === "range") return before ? "上一段" : "下一段";
        return before ? "上一年" : "下一年";
      }
      /* 三日与日视图都是「一天一格」地翻，提示语一致 */
      if (view === "three" || view === "day") return before ? "前一天" : "后一天";
      return before ? "上个月" : "下个月";
    }

    /* ============================================================
     * 日历标签页 · 统计视图（第五个段位）—— 版式参考 lumina 统计页：
     * 开头是「周期概览」数字卡网格（直接铺在页面上，不套卡片框），
     * 之后由一张张「卡片区块」纵排，区块头左标题、右副题、下有分隔线：
     * 每日分布（带轨道的柱状）/ 每日走势（SVG 折线 + 淡色面积 + 峰顶实心点）/
     * 类型分布（胶囊芯片网格，右侧是记录条数、悬停看累计用时）/
     * 全年记录热力（GitHub 式格子，列=周）。
     * 工具栏的标题与翻页箭头沿用：翻的是统计周期（周 / 月 / 年）。
     * 数据 = 当前数据源 + 当前类型筛选，与其它视图同一份口径；
     * 点柱子跳到对应的天 / 月视图。
     * ============================================================ */
    /* 按类型累计「时长(分钟)」与「条数」。时长口径与时间轴 / 表格同源
       （_resolveDayRanges，跟着「时间计算模式」走）：按天分组后，
       结束模式算「上一条 → 本条」，开始模式算「本条 → 下一条开始」；
       当天没有参照的那条按最小跨度计；显式区间优先；不跨天；
       时间解析不出的记录不计，没有类型的不累计。 */
    _statsTypeDurations(records) {
      const minutes = new Map();
      const counts = new Map();
      const byDay = new Map();
      (records || []).forEach((r) => {
        if (!r || !r.date) return;
        const range = this._parseTimeRange(r.time);
        if (!range) return;
        if (!byDay.has(r.date)) byDay.set(r.date, []);
        byDay.get(r.date).push({ rec: r, range });
      });
      byDay.forEach((list) => {
        list.sort((a, b) => a.range.start - b.range.start);
        const ranges = this._resolveDayRanges(list);
        list.forEach((x, i) => {
          const type = (x.rec.type || "").trim();
          if (!type) return;
          minutes.set(type, (minutes.get(type) || 0) + ranges[i].dur);
          counts.set(type, (counts.get(type) || 0) + 1);
        });
      });
      return { minutes, counts };
    }

    /* 分钟 → 「X时Y分」（小时不进位成天，与轻语时长口径一致） */
    _fmtStatsDur(min) {
      const h = Math.floor(min / 60);
      const mm = Math.round(min % 60);
      return h > 0 ? `${h}时${mm}分` : `${mm}分`;
    }

    _buildCalendarStatsHtml() {
      const period = this._calTabStatsPeriod || "year";
      const anchor =
        this._calTabStatsAnchor instanceof Date ? this._calTabStatsAnchor : new Date();
      const { start, end, label, bars } = this._computeLifeLogDockPeriod(period, anchor);
      const records = this._filterLifeLogDockByRange(
        this._calTabFilteredRecords(),
        start,
        end
      );
      const unit = this._calUnit();
      const todayKey = this._calKey(new Date());
      const now = new Date();

      /* —— 按天 / 按月计数（当前筛选口径） —— */
      const dayCount = {};
      const monthCount = {};
      records.forEach((r) => {
        if (!r || !r.date) return;
        dayCount[r.date] = (dayCount[r.date] || 0) + 1;
        const m = r.date.substring(0, 7);
        if (m) monthCount[m] = (monthCount[m] || 0) + 1;
      });
      const totalCount = records.length;
      const uniqueDays = Object.keys(dayCount).length;

      /* —— 类型分布：按类型累计「时长」与「条数」，纯展示不可点 ——
         芯片右侧显示条数，悬停气泡显示用时（时长规则见 _statsTypeDurations） */
      const chipStats = this._statsTypeDurations(records);
      const typeRows = Array.from(chipStats.counts.keys())
        .map((name) => ({
          name,
          cnt: chipStats.counts.get(name) || 0,
          min: chipStats.minutes.get(name) || 0,
          color: this._colorOf(name) || DEFAULT_TYPE_COLOR,
        }))
        .sort((a, b) => b.min - a.min);

      /* ==================== 每日分布：轨道柱 ==================== */
      const countOf = (b) =>
        period === "year"
          ? monthCount[b.date.getFullYear() + "-" + String(b.month).padStart(2, "0")] || 0
          : dayCount[b.key] || 0;
      const maxCnt = Math.max(1, ...bars.map(countOf));
      const barsHtml = bars
        .map((b) => {
          const cnt = countOf(b);
          const pct = Math.round((cnt / maxCnt) * 100);
          const isToday =
            period === "year"
              ? b.month === now.getMonth() + 1 && b.date.getFullYear() === now.getFullYear()
              : b.key === todayKey;
          /* 周 / 月的柱子跳到那天的日视图；年的柱子跳到那月的月视图 */
          const jump =
            period === "year"
              ? `${b.date.getFullYear()}-${String(b.month).padStart(2, "0")}`
              : b.key;
          const tip =
            period === "year"
              ? `${b.date.getFullYear()}年${b.month}月 · ${cnt} ${unit}`
              : `${b.key} · ${cnt} ${unit}`;
          const cls = ["north-caltab-stats-bcol"];
          if (isToday) cls.push("is-today");
          return `<div class="${cls.join(" ")}" data-caltab-statbar="${jump}" data-tip="${escapeHtml(
            tip
          )}">
                    <span class="north-caltab-stats-bcount">${cnt > 0 ? cnt : "0"}</span>
                    <div class="north-caltab-stats-btrack"><i class="north-caltab-stats-bfill" style="height:${pct}%"></i></div>
                    <span class="north-caltab-stats-blabel">${b.label}</span>
                </div>`;
        })
        .join("");
      const distTitle = period === "year" ? "月度分布" : "每日分布";
      const distMods =
        (period === "week" ? " is-week" : "") + (period === "year" ? " is-year" : "");

      /* ==================== 每日走势：SVG 折线 + 面积 ==================== */
      let trendPoints;
      let trendLabels;
      if (period === "year") {
        /* 年视图：全年逐日一条线（一年 365 天，标题是「每日走势」就得按天） */
        const y = anchor.getFullYear();
        const days = Math.round((new Date(y, 11, 31) - new Date(y, 0, 1)) / 86400000) + 1;
        trendPoints = [];
        for (let i = 0; i < days; i++) {
          const d = new Date(y, 0, 1 + i);
          const key = this._calKey(d);
          trendPoints.push({ key, cnt: dayCount[key] || 0 });
        }
        trendLabels = [];
        for (let m = 0; m < 12; m++) {
          trendLabels.push({ i: Math.round((new Date(y, m, 1) - new Date(y, 0, 1)) / 86400000), text: m + 1 + "月" });
        }
      } else {
        trendPoints = bars.map((b) => ({ key: b.key, cnt: dayCount[b.key] || 0 }));
        trendLabels =
          period === "week"
            ? trendPoints.map((p, i) => ({ i, text: bars[i].label }))
            : trendPoints
                .map((p, i) => ({ i, text: String(i + 1) }))
                .filter(
                  ({ i }) => i === 0 || (i + 1) % 5 === 0 || i === trendPoints.length - 1
                );
      }
      const trendMax = Math.max(1, ...trendPoints.map((p) => p.cnt));
      const trendPeakIdx = trendPoints.reduce(
        (bi, p, i, arr) => (p.cnt > arr[bi].cnt ? i : bi),
        0
      );
      /* 几何与 lumina 落笔时刻完全一致：viewBox 1000×200，上留 22 下留 44 */
      const TW = 1000;
      const TH = 200;
      const padT = 22;
      const padB = 44;
      const plotH = TH - padT - padB;
      const tx = (i) => (trendPoints.length > 1 ? (TW * i) / (trendPoints.length - 1) : TW / 2);
      const ty = (c) => padT + plotH - (plotH * c) / trendMax;
      let tickStep;
      if (trendMax <= 5) tickStep = 1;
      else if (trendMax <= 10) tickStep = 2;
      else tickStep = Math.ceil(trendMax / 5);
      let grid = "";
      for (let v = tickStep; v <= trendMax; v += tickStep) {
        grid += `<line x1="0" y1="${ty(v).toFixed(1)}" x2="${TW}" y2="${ty(v).toFixed(
          1
        )}" stroke="var(--b3-border-color)" stroke-dasharray="4 5" stroke-width="1" opacity="0.55"/>`;
        grid += `<text x="6" y="${(ty(v) - 5).toFixed(1)}" class="north-caltab-stats-axis-text">${v}</text>`;
      }
      const pts = trendPoints.map((p, i) => tx(i).toFixed(1) + "," + ty(p.cnt).toFixed(1));
      const linePath = "M" + pts.join(" L");
      const areaPath =
        trendPoints.length > 1
          ? linePath + ` L${TW},${ty(0).toFixed(1)} L0,${ty(0).toFixed(1)} Z`
          : "";
      const tipOf = (p) => escapeHtml(`${p.key} · ${p.cnt} ${unit}`);
      let dots = "";
      /* 点的疏密对齐 lumina 落笔时刻（24 个点间距约 80px）：
         周 / 月逐点都画；年视图 365 点则按密度采样成 ~30 组「命中区+空心点」，
         基线上仍有节奏点，峰值处成对补齐。命中区在可见点之前，
         悬浮命中区时相邻的可见点跟着放大 */
      const dotStride =
        trendPoints.length > 40 ? Math.ceil(trendPoints.length / 30) : 1;
      trendPoints.forEach((p, i) => {
        const isPeak = i === trendPeakIdx && p.cnt > 0;
        const sampled = i % dotStride === 0;
        if (!sampled && !isPeak) return;
        const hitR = trendPoints.length > 40 ? 7 : 10;
        dots += `<circle cx="${tx(i).toFixed(1)}" cy="${ty(p.cnt).toFixed(
          1
        )}" r="${hitR}" fill="transparent" class="north-caltab-stats-hit" data-tip="${tipOf(p)}"/>`;
        dots += `<circle cx="${tx(i).toFixed(1)}" cy="${ty(p.cnt).toFixed(1)}" r="${
          isPeak ? 5 : 3.5
        }" class="north-caltab-stats-dot${
          isPeak ? " is-peak" : ""
        }" data-tip="${tipOf(p)}"/>`;
      });
      /* X 轴标签：首尾贴边改左/右对齐，避免被 viewBox 裁切（lumina 同款处理） */
      const xlabels = trendLabels
        .map(({ i, text }) => {
          const side = i <= 0 ? "start" : i >= trendPoints.length - 1 ? "end" : "middle";
          return `<text x="${tx(i).toFixed(1)}" y="${TH - padB + 22}" text-anchor="${side}" class="north-caltab-stats-axis-text">${text}</text>`;
        })
        .join("");

      /* 峰值三格 + 底部 ✨ 提示条（lumina 落笔时刻同款布局） */
      const pk = trendPoints[trendPeakIdx] || { key: "—", cnt: 0 };
      const pm = String(pk.key).match(/^\d{4}-(\d{2})-(\d{2})$/);
      const peakLabel = pm ? `${+pm[1]}月${+pm[2]}日` : pk.key;
      const peakPct = totalCount > 0 ? ((pk.cnt / totalCount) * 100).toFixed(1) : "0.0";
      const periodName =
        period === "year"
          ? `${anchor.getFullYear()} 年`
          : period === "month"
          ? `${anchor.getFullYear()} 年${anchor.getMonth() + 1} 月`
          : "本周";
      const scopeName = period === "year" ? "全年" : period === "month" ? "当月" : "本周";
      const trendSub = `${periodName}共 ${totalCount} ${unit}`;
      const trendBody =
        totalCount > 0
          ? `<div class="north-caltab-stats-rhythm-head">哪些天是你的记录高峰？</div>
            <div class="north-caltab-stats-peak-row">
                <div class="north-caltab-stats-peak-item"><div class="north-caltab-stats-peak-value">${peakLabel}</div><div class="north-caltab-stats-peak-label">记录高峰</div></div>
                <div class="north-caltab-stats-peak-item"><div class="north-caltab-stats-peak-value">${pk.cnt} 条</div><div class="north-caltab-stats-peak-label">单日峰值</div></div>
                <div class="north-caltab-stats-peak-item"><div class="north-caltab-stats-peak-value">${peakPct}%</div><div class="north-caltab-stats-peak-label">占${scopeName}记录</div></div>
            </div>
            <svg class="north-caltab-stats-trend" viewBox="0 0 ${TW} ${TH}" role="img" aria-label="每日记录走势折线图">
                ${grid}
                <path d="${areaPath}" class="north-caltab-stats-trend-area"/>
                <path d="${linePath}" class="north-caltab-stats-trend-line"/>
                ${dots}
                ${xlabels}
            </svg>
            <div class="north-caltab-stats-rhythm-hint">✨ ${peakLabel} 是你的记录高峰 —— ${periodName}共有 ${pk.cnt} ${unit}诞生于这天，占${scopeName} ${peakPct}%</div>`
          : `<div class="north-caltab-stats-empty">这段周期还没有记录，记下第一条就能看到走势了</div>`;

      /* ==================== 类型分布：环形图 + 胶囊芯片图例 ====================
         基础行数据（页面周期口径），只喂给「周期概览」的类型数卡片；
         真正的环形图区块在下面 —— 它带自己的一套 日/周/月/年 周期切换
         （与「时长统计」同款），两者互不干扰。 */

      /* 卡片区块：区块头左标题、右副题、下有分隔线（后续各区块共用） */
      const section = (title, sub, body) =>
        `<div class="north-caltab-stats-section">
            <div class="north-caltab-stats-header"><span>${title}</span>${
              sub ? `<span class="north-caltab-stats-sub">${sub}</span>` : ""
            }</div>
            ${body}
        </div>`;

      /* ==================== 全年记录热力：1:1 复刻 lumina 贡献图 ==================== */
      const hy = anchor.getFullYear();
      const heatCount = {};
      this._calTabFilteredRecords().forEach((r) => {
        if (!r || !r.date || !r.date.startsWith(hy + "-")) return;
        heatCount[r.date] = (heatCount[r.date] || 0) + 1;
      });
      const yearStart = new Date(hy, 0, 1);
      const gridStart = new Date(yearStart);
      /* 周日起始（1:1 对齐 lumina 贡献图的取周方式） */
      gridStart.setDate(yearStart.getDate() - yearStart.getDay());
      const yearEnd = new Date(hy, 11, 31);
      const weeks = Math.ceil((Math.round((yearEnd - gridStart) / 86400000) + 1) / 7);
      const monthStart = new Array(12).fill(-1);
      const monthEnd = new Array(12).fill(-1);
      let heatCols = "";
      for (let w = 0; w < weeks; w++) {
        let col = "";
        for (let d = 0; d < 7; d++) {
          const dt = new Date(gridStart);
          dt.setDate(gridStart.getDate() + w * 7 + d);
          if (dt.getFullYear() !== hy) {
            col += '<i class="north-caltab-stats-heatcell is-empty"></i>';
            continue;
          }
          const key = this._calKey(dt);
          const c = heatCount[key] || 0;
          /* 固定档位（lumina 同款）：1-2 条 level-2 / 3-4 条 level-3 / 5+ 条 level-4 */
          const lvl = c >= 5 ? " level-4" : c >= 3 ? " level-3" : c >= 1 ? " level-2" : "";
          const mo = dt.getMonth();
          if (monthStart[mo] === -1) monthStart[mo] = w;
          monthEnd[mo] = w;
          col += `<i class="north-caltab-stats-heatcell${lvl}" data-tip="${escapeHtml(key + " · " + (c > 0 ? `${c} ${unit}` : "暂无"))}"></i>`;
        }
        heatCols += `<div class="north-caltab-stats-heatcol">${col}</div>`;
      }
      const monthNames = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
      const heatMonths = monthNames
        .map((name, m) => {
          if (monthStart[m] === -1) return "";
          const mid = (monthStart[m] + monthEnd[m]) / 2;
          const left = (((mid + 0.5) / weeks) * 100).toFixed(2) + "%";
          return `<span class="north-caltab-stats-heatmonth" style="left:${left}">${name}</span>`;
        })
        .join("");
      const heatBody = `<div class="north-caltab-stats-heat">
            <div class="north-caltab-stats-heatcols">${heatCols}</div>
            <div class="north-caltab-stats-heatmonths">${heatMonths}</div>
        </div>`;
      /* 热力图不带区块头（标题/副题隐藏），与 lumina 贡献图区块一致：卡片内直接是格子 */
      const heatSection = `<div class="north-caltab-stats-section">${heatBody}</div>`;

      /* ==================== 每日记录：目标月逐日轨道柱（lumina 同款） ====================
         看哪个月：统计年份是当年就看当月，否则看该年记录最多的一个月。
         纯展示不可点，悬浮气泡显示当天条数。 */
      const dailyYear = anchor.getFullYear();
      const dailyYearDayCount = {};
      this._calTabFilteredRecords().forEach((r) => {
        if (!r || !r.date || !r.date.startsWith(dailyYear + "-")) return;
        dailyYearDayCount[r.date] = (dailyYearDayCount[r.date] || 0) + 1;
      });
      let dailyMonth;
      if (dailyYear === now.getFullYear()) {
        dailyMonth = now.getMonth();
      } else {
        const monthTotals = new Array(12).fill(0);
        Object.keys(dailyYearDayCount).forEach((k) => {
          monthTotals[+k.split("-")[1] - 1] += dailyYearDayCount[k];
        });
        dailyMonth = 0;
        monthTotals.forEach((c, i) => {
          if (c > monthTotals[dailyMonth]) dailyMonth = i;
        });
      }
      const daysInDailyMonth = new Date(dailyYear, dailyMonth + 1, 0).getDate();
      const dailyMonthName = `${dailyYear}-${pad2(dailyMonth + 1)}`;
      const dailyCounts = Array.from({ length: daysInDailyMonth }, (_, i) => {
        return dailyYearDayCount[`${dailyYear}-${pad2(dailyMonth + 1)}-${pad2(i + 1)}`] || 0;
      });
      const dailyTotal = dailyCounts.reduce((a, b) => a + b, 0);
      const dailyMax = Math.max(0, ...dailyCounts);
      const dailyBars = dailyCounts
        .map((cnt, i) => {
          const day = i + 1;
          const pct = dailyMax > 0 ? Math.round((cnt / dailyMax) * 100) : 0;
          return `<div class="north-caltab-stats-dbar" data-tip="${escapeHtml(
            `${dailyMonthName}-${pad2(day)}: ${cnt} ${unit}`
          )}">
                <div class="north-caltab-stats-dbar-track"><i class="north-caltab-stats-dbar-fill" style="height:${pct}%"></i></div>
                <span class="north-caltab-stats-dbar-count">${cnt > 0 ? cnt : "0"}</span>
                <span class="north-caltab-stats-dbar-label">${day}日</span>
            </div>`;
        })
        .join("");
      const dailySection = section(
        `每日记录 — ${dailyMonthName}`,
        `${dailyMonthName} 共 ${dailyTotal} ${unit}`,
        `<div class="north-caltab-stats-dbars">${dailyBars}</div>`
      );

      /* ==================== 统计明细：类型 × 月份矩阵（lumina 同款） ====================
         行=类型（无类型的归到「(无类型)」置底）、列=12 个月 + 总计列，
         单元格「占比% + 条数」并列（占比按全年总数算），空格画「-」，
         tfoot 一行「总计」。年内没有记录时整个区块不渲染。 */
      const NO_TYPE = "(无类型)";
      const unitShort = unit.replace(/记录$|文档$/, "");
      const detailMap = {};
      let detailYearTotal = 0;
      this._calTabFilteredRecords().forEach((r) => {
        if (!r || !r.date || !r.date.startsWith(hy + "-")) return;
        const t = ((r.type || "").trim() || NO_TYPE);
        const m = +r.date.substring(5, 7) - 1;
        if (!(m >= 0 && m <= 11)) return;
        if (!detailMap[t]) detailMap[t] = new Array(12).fill(0);
        detailMap[t][m]++;
        detailYearTotal++;
      });
      const detailNames = Object.keys(detailMap)
        .sort((a, b) => {
          if (a === NO_TYPE) return 1;
          if (b === NO_TYPE) return -1;
          return a.localeCompare(b, "zh-CN");
        })
        .map((name) => ({
          name,
          months: detailMap[name],
          total: detailMap[name].reduce((a, b) => a + b, 0),
        }));
      const detailCell = (cnt) => {
        if (!cnt) return '<span class="north-caltab-stats-dcell-empty">-</span>';
        const pct = detailYearTotal > 0 ? ((cnt / detailYearTotal) * 100).toFixed(1) : "0.0";
        return `<div class="north-caltab-stats-dval"><span class="north-caltab-stats-dval-pct">${pct}%</span><span class="north-caltab-stats-dval-count">${cnt}${unitShort}</span></div>`;
      };
      const detailRows = detailNames
        .map(
          (row) => `<tr>
                <td class="north-caltab-stats-dcell-type" ${row.name === NO_TYPE ? "" : `style="color:${this._colorOf(row.name) || DEFAULT_TYPE_COLOR}"`}>${escapeHtml(row.name)}</td>
                <td class="north-caltab-stats-dcell-total">${detailCell(row.total)}</td>
                ${row.months.map((cnt) => `<td class="north-caltab-stats-dcell-day">${detailCell(cnt)}</td>`).join("")}
            </tr>`
        )
        .join("");
      const detailSection =
        detailYearTotal > 0
          ? section(
              "统计明细",
              `${hy} 年共 ${detailYearTotal}${unitShort}`,
              `<div class="north-caltab-stats-dtable-wrap">
                <table class="north-caltab-stats-dtable">
                    <thead>
                        <tr>
                            <th class="north-caltab-stats-dth-type">类型</th>
                            <th class="north-caltab-stats-dth-total">总计</th>
                            ${Array.from({ length: 12 }, (_, m) => `<th class="north-caltab-stats-dth-month">${m + 1}月</th>`).join("")}
                        </tr>
                    </thead>
                    <tbody>${detailRows}</tbody>
                    <tfoot>
                        <tr>
                            <td class="north-caltab-stats-dcell-type north-caltab-stats-dcell-total-row">总计</td>
                            <td class="north-caltab-stats-dcell-total north-caltab-stats-dcell-total-row">
                                <div class="north-caltab-stats-dval"><span class="north-caltab-stats-dval-count">${detailYearTotal}${unitShort}</span></div>
                            </td>
                            ${Array.from({ length: 12 }, (_, m) => {
                              const mt = detailNames.reduce((s, row) => s + row.months[m], 0);
                              return `<td class="north-caltab-stats-dcell-day north-caltab-stats-dcell-total-row">${
                                mt > 0 ? `<div class="north-caltab-stats-dval"><span class="north-caltab-stats-dval-count">${mt}${unitShort}</span></div>` : '<span class="north-caltab-stats-dcell-empty">-</span>'
                              }</td>`;
                            }).join("")}
                        </tr>
                    </tfoot>
                </table>
            </div>`
            )
          : "";

      /* ==================== 周期概览：数字卡网格 ==================== */
      const periodDays = Math.max(
        1,
        Math.round((end.getTime() - start.getTime()) / 86400000) + 1
      );
      let peakKey = "";
      let peakCnt = 0;
      Object.keys(dayCount).forEach((k) => {
        if (dayCount[k] > peakCnt) {
          peakCnt = dayCount[k];
          peakKey = k;
        }
      });
      /* 最长连续记录天数：日期键排序后找最长的逐日连号（跨夏令时用日差取整判连） */
      let streak = 0;
      let bestStreak = 0;
      let prevMs = 0;
      Object.keys(dayCount)
        .sort()
        .forEach((k) => {
          const ms = new Date(k + "T00:00:00").getTime();
          streak = prevMs && Math.round((ms - prevMs) / 86400000) === 1 ? streak + 1 : 1;
          if (streak > bestStreak) bestStreak = streak;
          prevMs = ms;
        });
      const cards = [
        [String(totalCount), "记录" + (unit === "篇文档" ? "文档" : "次数")],
        [String(uniqueDays), "有记录天数"],
        [(totalCount / periodDays).toFixed(1), "日均"],
        [String(peakCnt), "单日最多"],
        [String(typeRows.length), "类型数"],
        [String(bestStreak), "连续天数"],
      ]
        .map(
          ([v, lab]) =>
            `<div class="north-caltab-stats-cell"><div class="north-caltab-stats-num">${v}</div><div class="north-caltab-stats-lab">${lab}</div></div>`
        )
        .join("");

      /* ==================== 时长统计：各类型 × 日/周/月/年 ====================
         独立于整页周期的局部周期（切换时锚点回到今天），翻页箭头只挪自己的锚点。
         每个类型一行横向时长条：轨道按当期最长的类型归一，填充用类型自身配色。 */
      if (!this._calTabDurPeriod) this._calTabDurPeriod = "month";
      if (!(this._calTabDurAnchor instanceof Date)) this._calTabDurAnchor = new Date();
      const durPeriod = this._calTabDurPeriod;
      const durWindow = this._computeLifeLogDockPeriod(durPeriod, this._calTabDurAnchor);
      const durStats = this._statsTypeDurations(
        this._filterLifeLogDockByRange(
          this._calTabFilteredRecords(),
          durWindow.start,
          durWindow.end
        )
      );
      const durRows = Array.from(durStats.minutes.keys())
        .map((name) => ({
          name,
          min: durStats.minutes.get(name) || 0,
          color: this._colorOf(name) || DEFAULT_TYPE_COLOR,
        }))
        .sort((a, b) => b.min - a.min);
      const durTotalMin = durRows.reduce((s, r) => s + r.min, 0);
      const durMax = Math.max(1, ...durRows.map((r) => r.min));
      /* 名称列宽按当期最长的类型名自适应（中文按全宽、拉丁按 0.55 估），
         列宽刚好贴住最长的名字，左侧不会再空出一大片 */
      const nameUnits = Math.max(
        1,
        ...durRows.map((t) =>
          [...t.name].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 1 : 0.55), 0)
        )
      );
      const durNameW = Math.ceil(nameUnits * 13) + 4;
      const durBars = durRows
        .map((t) => {
          const pct = Math.round((t.min / durMax) * 100);
          return `<div class="north-caltab-stats-durrow" data-tip="${escapeHtml(
            `${t.name} · ${this._fmtStatsDur(t.min)}`
          )}">
                <span class="north-caltab-stats-durname">${escapeHtml(t.name)}</span>
                <div class="north-caltab-stats-durtrack"><i class="north-caltab-stats-durfill" style="width:${pct}%;background:${t.color}"></i></div>
                <span class="north-caltab-stats-durval">${this._fmtStatsDur(t.min)}</span>
            </div>`;
        })
        .join("");
      const durPeriodNames = { day: "日", week: "周", month: "月", year: "年" };
      const durPrevTips = { day: "前一天", week: "上一周", month: "上个月", year: "上一年" };
      const durNextTips = { day: "后一天", week: "下一周", month: "下个月", year: "下一年" };
      /* 区块头一行装下：左「时长统计」，右侧依次为周期 pill、翻页、周期文字与合计 */
      const durSection = `<div class="north-caltab-stats-section">
            <div class="north-caltab-stats-header north-caltab-stats-header-dur">
                <span>时长统计</span>
                <div class="north-caltab-stats-durhead">
                    <div class="north-caltab-segments north-caltab-stats-durperiods">
                        ${["day", "week", "month", "year"]
                          .map(
                            (p) =>
                              `<button class="${durPeriod === p ? "active" : ""}" data-caltab-durperiod="${p}">${durPeriodNames[p]}</button>`
                          )
                          .join("")}
                    </div>
                    <div class="north-caltab-stats-durnav">
                        <button class="north-caltab-stats-durnavbtn" data-caltab-durnav="prev" data-tip="${durPrevTips[durPeriod]}"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><use xlink:href="#iconLeft"></use></svg></button>
                        <span class="north-caltab-stats-durlabel">${durWindow.label}</span>
                        <button class="north-caltab-stats-durnavbtn" data-caltab-durnav="next" data-tip="${durNextTips[durPeriod]}"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><use xlink:href="#iconRight"></use></svg></button>
                    </div>
                    <span class="north-caltab-stats-sub">合计 ${this._fmtStatsDur(durTotalMin)}</span>
                </div>
            </div>
            ${
              durRows.length
                ? `<div class="north-caltab-stats-durlist" style="--dur-namew:${durNameW}px">${durBars}</div>`
                : `<div class="north-caltab-stats-empty">这段周期还没有可统计时长的记录</div>`
            }
        </div>`;

      /* ==================== 类型分布：环形图 + 芯片图例（自配周期） ====================
         与「时长统计」同款局部周期（日 / 周 / 月 / 年，切换时锚点回到今天，
         翻页箭头只挪自己的锚点）。环形图在**上**（更大、居中），扇区按条数占比
         切分、用类型自身配色，中心放总数；芯片图例铺满**下方**，右侧直接标
         占比%，条数与用时进悬停气泡 —— 一份数据两处展示，不另起口径。 */
      if (!this._calTabTypePeriod) this._calTabTypePeriod = "month";
      if (!(this._calTabTypeAnchor instanceof Date)) this._calTabTypeAnchor = new Date();
      const typePeriod = this._calTabTypePeriod;
      const typeWindow = this._computeLifeLogDockPeriod(typePeriod, this._calTabTypeAnchor);
      const typeStats = this._statsTypeDurations(
        this._filterLifeLogDockByRange(
          this._calTabFilteredRecords(),
          typeWindow.start,
          typeWindow.end
        )
      );
      const typePieRows = Array.from(typeStats.counts.keys())
        .map((name) => ({
          name,
          cnt: typeStats.counts.get(name) || 0,
          min: typeStats.minutes.get(name) || 0,
          color: this._colorOf(name) || DEFAULT_TYPE_COLOR,
        }))
        .sort((a, b) => b.cnt - a.cnt);
      const typeTotalCnt = typePieRows.reduce((s, t) => s + t.cnt, 0);
      /* 环形几何：stroke-dasharray 画弧 —— 每段弧长 = 占比 × 周长（再扣 2px 缝），
         dashoffset 依次前移累出首尾相接；rotate(-90) 让 0% 从顶部起，
         只有 1 个类型时不留缝（一整圈就是一个颜色）。 */
      const DONUT_S = 120;
      const DONUT_C = DONUT_S / 2;
      const DONUT_R = 44;
      const DONUT_CIRC = 2 * Math.PI * DONUT_R;
      const DONUT_GAP = typePieRows.length > 1 ? 2 : 0;
      let donutAcc = 0;
      const donutSegs = typePieRows
        .map((t) => {
          const frac = typeTotalCnt > 0 ? t.cnt / typeTotalCnt : 0;
          const len = Math.max(0, frac * DONUT_CIRC - DONUT_GAP);
          const seg = `<circle cx="${DONUT_C}" cy="${DONUT_C}" r="${DONUT_R}" fill="none" stroke="${
            t.color
          }" stroke-width="16" stroke-dasharray="${len.toFixed(2)} ${(
            DONUT_CIRC - len
          ).toFixed(2)}" stroke-dashoffset="${(-donutAcc).toFixed(
            2
          )}" class="north-caltab-stats-donut-seg" data-tip="${escapeHtml(
            `${t.name} · ${t.cnt} ${unit} · ${(frac * 100).toFixed(1)}% · 用时 ${this._fmtStatsDur(t.min)}`
          )}"></circle>`;
          donutAcc += frac * DONUT_CIRC;
          return seg;
        })
        .join("");
      const donutHtml = `<div class="north-caltab-stats-donut">
            <svg viewBox="0 0 ${DONUT_S} ${DONUT_S}" role="img" aria-label="类型占比环形图">
                <g transform="rotate(-90 ${DONUT_C} ${DONUT_C})">${donutSegs}</g>
            </svg>
            <div class="north-caltab-stats-donut-center"><b>${typeTotalCnt}</b><span>${
              unitShort || unit
            }</span></div>
        </div>`;
      const typeChipsHtml = typePieRows
        .map((t) => {
          const pct = typeTotalCnt > 0 ? ((t.cnt / typeTotalCnt) * 100).toFixed(1) : "0.0";
          return `<div class="north-caltab-stats-chip" data-tip="${escapeHtml(
            `${t.name} · ${t.cnt} ${unit} · 用时 ${this._fmtStatsDur(t.min)}`
          )}">
                <i class="north-caltab-stats-chip-dot" style="background:${t.color}"></i>
                <span class="north-caltab-stats-chip-name">${escapeHtml(t.name)}</span>
                <span class="north-caltab-stats-chip-val">${pct}%</span>
            </div>`;
        })
        .join("");
      const typePeriodNames = { day: "日", week: "周", month: "月", year: "年" };
      const typePrevTips = { day: "前一天", week: "上一周", month: "上个月", year: "上一年" };
      const typeNextTips = { day: "后一天", week: "下一周", month: "下个月", year: "下一年" };
      const typeSection = `<div class="north-caltab-stats-section">
            <div class="north-caltab-stats-header north-caltab-stats-header-dur">
                <span>类型分布</span>
                <div class="north-caltab-stats-durhead">
                    <div class="north-caltab-segments north-caltab-stats-durperiods">
                        ${["day", "week", "month", "year"]
                          .map(
                            (p) =>
                              `<button class="${typePeriod === p ? "active" : ""}" data-caltab-typeperiod="${p}">${typePeriodNames[p]}</button>`
                          )
                          .join("")}
                    </div>
                    <div class="north-caltab-stats-durnav">
                        <button class="north-caltab-stats-durnavbtn" data-caltab-typenav="prev" data-tip="${typePrevTips[typePeriod]}"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><use xlink:href="#iconLeft"></use></svg></button>
                        <span class="north-caltab-stats-durlabel">${typeWindow.label}</span>
                        <button class="north-caltab-stats-durnavbtn" data-caltab-typenav="next" data-tip="${typeNextTips[typePeriod]}"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><use xlink:href="#iconRight"></use></svg></button>
                    </div>
                    <span class="north-caltab-stats-sub">合计 ${typeTotalCnt}${unitShort}</span>
                </div>
            </div>
            ${
              typePieRows.length
                ? `<div class="north-caltab-stats-typedist">${donutHtml}<div class="north-caltab-stats-chips">${typeChipsHtml}</div></div>`
                : `<div class="north-caltab-stats-empty">这段周期还没有带类型的记录</div>`
            }
        </div>`;

      /* ==================== 拼装 ====================
         顶栏（周期 pill + 周期文字）暂不渲染：与工具栏左上的日期显示重复，
         那个位置留给后续规划；周期本身仍由「今天 / 翻页箭头」按当前周期走。 */
      return `<div class="north-caltab-stats">
            <div class="north-caltab-stats-grid">${cards}</div>
            ${heatSection}
            ${dailySection}
            ${section(distTitle, `共 ${totalCount} ${unit}`, `<div class="north-caltab-stats-bars${distMods}">${barsHtml}</div>`)}
            ${detailSection}
            ${section("每日走势", trendSub, trendBody)}
            ${durSection}
            ${typeSection}
        </div>`;
    }
    /* 时间轴视图（周 / 三日 / 日）摆块的三步走：
       ① _parseCalTimelineRecords —— 解析、排序，并按当前时间计算模式算出真实起止；
       ② _calTimelineLayout —— 按各天记录估出「弹性小时高」：本插件偏记录，
          密集时段几分钟一条，块又保底 22px 高，固定 40px/小时必然叠字。
          哪个小时装不下就把那个小时撑高（全部列共享一套小时高，刻度列的
          标签才始终对得上线）；空旷时段维持 40px，看起来与普通日历无异。
       ③ _buildCalendarTimelineEvents —— 块按时间比例定位，但与上一块
          贴上时只后退到刚好不叠的位置：拥挤的记录上下排开，永不互相压字。 */

    /* 给「同一天」的记录按当前时间计算模式算出真实起止（分钟）。
       入参 sorted 必须是已按时间升序的 [{ rec, range }]，range 来自 _parseTimeRange。
       返回等长的 [{ start, end, hasRange, dur }]：
         hasRange false —— 当天首条（结束模式）/ 末条（开始模式）没有参照，
                           起止只用来给块一个最小高度，文案不写成区间；
         dur            —— 真正计入时长口径的分钟数，hasRange false 时为 0：
                           首末条本来就不知道它持续了多久，宁可不计，
                           也不编一个 30 分钟进去 —— 编出来的数字会顺着
                           链条污染下一条的起点，跟 Dock 时间线的口径就岔开了。
       参照的那条一律取它的**节点时间**（range.start），不取它算出来的起止 ——
       记录自己写明区间（08:30 - 09:30）时，无论选哪个模式都直接采用，不再按模式推。 */
    _resolveDayRanges(sorted) {
      const mode = this._timeCalcMode();
      return sorted.map((x, i) => {
        const anchor = x.range.start;
        const explicitEnd = x.range.end;
        /* 自己写明的区间：任何模式下都照用 */
        if (explicitEnd !== null) {
          return { start: anchor, end: explicitEnd, hasRange: true, dur: explicitEnd - anchor };
        }
        /* 开始模式看下一条，结束模式看上一条；两头都没有就看天 */
        const ref = mode === "start" ? sorted[i + 1] : sorted[i - 1];
        if (!ref) {
          return {
            start: anchor,
            end: anchor + WEEK_DEFAULT_MIN,
            hasRange: false,
            dur: 0,
          };
        }
        const start = mode === "start" ? anchor : ref.range.start;
        let end = mode === "start" ? ref.range.start : anchor;
        /* 起点被写死的区间顶到后面时（如 08:00 - 11:00 之后又记了 10:00），
           给 1 分钟跨度让块站得住；节点时间本身永远不动 */
        if (end <= start) end = start + 1;
        return { start, end, hasRange: true, dur: end - start };
      });
    }

    /* 解析一天的记录为 { record, range, start, end, hasRange, dur }，时间非法的丢弃。
       start / end 是展示与摆块真正用的起止，dur 是计入时长口径的分钟数
       （三者都由 _resolveDayRanges 按「时间计算模式」算出）；
       range.start 始终是记录里那个节点时间本身，只写节点时间时用它。 */
    _parseCalTimelineRecords(records) {
      const list = (records || [])
        .map((r) => ({ record: r, range: this._parseTimeRange(r.time) }))
        .filter((x) => x.range)
        .sort((a, b) => a.range.start - b.range.start);
      const ranges = this._resolveDayRanges(list);
      return list.map((x, i) => Object.assign({}, x, ranges[i]));
    }

    /* 估各小时需要多高，两路一起算，取大者：
       ① 按均匀 40px/小时把每天预演摆一遍（保底块高 + 间距会把密集记录往后顶），
          块底落到哪个小时，就把那个小时撑到装得下 —— 跨时块不重复计入沿途小时；
       ② 同一小时里起始的记录堆：按「最小块高 + 间距」从整点附近往下摞也要装得下，
          否则整堆会顺流冲进后面几小时，离自己的时间越来越远。 */
    _calTimelineLayout(parsedByDate, days) {
      const need = new Array(24).fill(0);
      days.forEach((d) => {
        const parsed = parsedByDate[this._calKey(d)] || [];
        if (!parsed.length) return;
        const byHour = new Map();
        let prevBottom = -WEEK_EVENT_GAP;
        parsed.forEach((x) => {
          const top = Math.max(
            (x.start / 60) * WEEK_HOUR_H,
            prevBottom + WEEK_EVENT_GAP
          );
          const bottom =
            top +
            Math.max(
              WEEK_MIN_BLOCK_H,
              ((x.end - x.start) / 60) * WEEK_HOUR_H
            );
          prevBottom = bottom;
          const hb = Math.max(
            0,
            Math.min(23, Math.floor((bottom - 0.01) / WEEK_HOUR_H))
          );
          need[hb] = Math.max(need[hb], bottom - hb * WEEK_HOUR_H);
          const h = Math.max(0, Math.min(23, Math.floor(x.start / 60)));
          if (!byHour.has(h)) byHour.set(h, []);
          byHour.get(h).push(x.start);
        });
        /* 只有同一小时里起始 ≥ 2 条才可能互相挤：单条记录的溢出交给 ① 兜，
           不然随手记的半点记录也会把所在小时撑高，稀疏日就跟旧版长得不一样了 */
        byHour.forEach((starts, h) => {
          if (starts.length < 2) return;
          const stackH =
            starts.length * WEEK_MIN_BLOCK_H +
            (starts.length - 1) * WEEK_EVENT_GAP;
          const frac = (starts[0] - h * 60) / 60;
          need[h] = Math.max(need[h], stackH + frac * WEEK_HOUR_H);
        });
      });
      const hourH = need.map((n) => Math.max(WEEK_HOUR_H, Math.ceil(n)));
      const cum = [0];
      for (let h = 0; h < 24; h++) cum.push(cum[h] + hourH[h]);
      /* 分钟 → 该视图里的纵向像素。各列与刻度都用它，整体只有这一份几何 */
      const yOf = (min) => {
        const h = Math.max(0, Math.min(23, Math.floor(min / 60)));
        return cum[h] + ((min - h * 60) / 60) * hourH[h];
      };
      return { hourH, cum, total: cum[24], yOf };
    }

    /* 把一天的记录换算成时间轴上的块，返回 HTML 字符串数组。
       块的起止直接取 _resolveDayRanges 按「时间计算模式」算出的 start / end ——
       结束模式下块从当天上一条延伸到本条，开始模式下从本条延伸到下一条，
       块在图上的位置本身就表达了这个模式。
       两头没有参照的那条（hasRange 为 false）只有节点时间可写，
       给一个最小高度（那段时间本来就没有数据）。
       top / height 在 JS 里算好写进 style：高度还得反过来决定时间行怎么摆，
       这件事 CSS 做不到（矮块里的两行会被裁掉半行）。 */
    _buildCalendarTimelineEvents(parsed, layout) {
      const yOf = layout.yOf;
      /* 顺序摆 + 最小间距：上一块的块底就是下一块的近端下限，
         挤在一起的记录（如 12:39 / 12:40 各一条）依次往下排，不再叠字 */
      let prevBottom = -WEEK_EVENT_GAP;
      return parsed.map((x) => {
        const top = Math.max(yOf(x.start), prevBottom + WEEK_EVENT_GAP);
        const height = Math.max(WEEK_MIN_BLOCK_H, yOf(x.end) - yOf(x.start));
        prevBottom = top + height;

        /* 块够高就上下两行：标题一行、完整区间一行。
           不够高（当天首 / 末条基本都是这种）就压成一行，时间只写节点时间 ——
           宁可少写个结束时间，也不能让记录自己的那个时间整个看不见。
           一行时把时间放在标题**前面**：时间短且固定，放前面保证不会被裁掉，
           要裁就裁标题，反正完整记录还挂在悬停气泡上。 */
        const compact = height < WEEK_SHOWTIME_H;
        const label =
          !compact && x.hasRange
            ? `${this._fmtMin(x.start)} - ${this._fmtMin(x.end)}`
            : this._fmtMin(x.range.start);

        const r = x.record;
        const c = this._calRecordColor(r);
        const hint = this._iconHint(r);
        const tip = `${r.time || ""} ${r.type || ""}：${this._brToSpace(r.content)}${hint ? ` (${hint})` : ""}`.trim();
        const style = `top:${top.toFixed(1)}px;height:${height.toFixed(1)}px${
          c ? `;--tt-c:${c}` : ""
        }`;
        /* 时间前面挂一枚思源内置的表针图标（iconClock），受「时间图标」开关控制。
           直接用 #iconClock 符号 —— 它与插件里其它图标同一套来源，
           symbol 自带 stroke="currentColor"，所以颜色自动跟这一行的文字色走，
           深浅（含内容颜色开关带来的透明度）都不用在这里管。
           尺寸与偏移写在 index.css 的 .north-caltab-wv-event-time-icon 里。 */
        const clockIcon = this._calShowIcon()
          ? `<svg class="north-caltab-wv-event-time-icon" viewBox="0 0 24 24" fill="currentColor" width="11" height="11"><use xlink:href="#iconClock"></use></svg>`
          : "";
        const timeSpan = `<span class="north-caltab-wv-event-time">${clockIcon}${escapeHtml(
          label
        )}</span>`;
        /* 标题写成「类型 | 内容」（对齐参考图里的日程块），受「展示类型」开关控制。
           只有时间轴视图（周 / 三日 / 日）这样，月视图条目与当天详情的列表仍只显示内容 ——
           那两处一行里塞不下类型，硬加会把内容挤没。
           没有类型的记录不补分隔符，免得出现孤零零一个「| 内容」。 */
        const titleSpan = `<span class="north-caltab-wv-event-title">${
          this._calShowType() && r.type ? `${escapeHtml(r.type)} | ` : ""
        }${escapeHtml(r.content || "")}</span>`;
        return `<div class="north-caltab-wv-event${
          compact ? " is-compact" : ""
        }" style="${style}" data-cal-id="${escapeHtml(r.id || "")}" data-tip="${escapeHtml(
          tip
        )}">${compact ? timeSpan + titleSpan : titleSpan + timeSpan}</div>`;
      });
    }

    /* ============================================================
     * 表格视图（第六个段位）
     * 当月记录按日分组排成一张表：日期分组头 + 一行一条，表头与分组头都吸顶。
     * 数据与其它视图共用同一份（数据源 + 类型筛选 + 月份锚点），
     * 所以不会出现「切个视图就换了口径」。
     * 列只放四样：时间 / 类型 / 内容 / 时长 —— 恰好是其它视图都在表达的四件事，
     * 这里只是把它们排成能直接竖着扫的一列列，不额外发明新信息。
     * ============================================================ */

    /* 一天的记录 → 带「起止 + 时长」的行数据。
       起止与时长跟时间轴 / 统计同源（_resolveDayRanges，按「时间计算模式」算）：
       结束模式一条记录算「上一条 → 本条」，开始模式算「本条 → 下一条开始」；
       当天没有参照的那条不编区间（hasRange 为 false，时间列只写节点时间），
       时长仍按最小跨度计，好让分组头能报出一个「共 X」。不跨天。
       时间解析不出的行不编时长（表格里显示 —）。 */
    _calDayRows(records) {
      const rows = (records || []).map((r) => ({
        record: r,
        range: this._parseTimeRange(r && r.time),
      }));
      const timed = rows
        .filter((x) => x.range)
        .sort((a, b) => a.range.start - b.range.start);
      const ranges = this._resolveDayRanges(timed);
      timed.forEach((x, i) => {
        x.start = ranges[i].start;
        x.end = ranges[i].end;
        x.hasRange = ranges[i].hasRange;
        x.dur = ranges[i].dur;
      });
      /* 有时间的按时间先后靠前，没时间的沉到最后（顺序稳定，不再打乱） */
      return rows.sort((a, b) => {
        const sa = a.range ? a.range.start : Infinity;
        const sb = b.range ? b.range.start : Infinity;
        return sa - sb;
      });
    }

    /* 表格视图工具行的行匹配：搜索关键字（只搜「内容」这一列）+ 时间范围筛选
       （类型筛选走共用的 _calTabTypeFilter，已经在 _calTabRecordsByDate 里筛过，
       这里不重复）。搜索不分大小写；时间范围以「今天」为基准：
       今日 / 本周（按设置的每周起始日对齐）/ 本月，落在范围外的行整行不出现。 */
    _calTableRecordMatch(r, dateKey) {
      const tf = this._calTabTableTimeFilter;
      if (tf) {
        if (!dateKey) return false;
        const now = new Date();
        if (tf === "today") {
          if (dateKey !== this._calKey(now)) return false;
        } else if (tf === "week") {
          const start = this._calTabWeekStartDate(now);
          const end = new Date(start);
          end.setDate(start.getDate() + 6);
          const d = new Date(`${dateKey}T00:00:00`);
          if (d < start || d > end) return false;
        } else if (tf === "month") {
          if (dateKey.slice(0, 7) !== `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`)
            return false;
        }
      }
      const q = (this._calTabTableSearch || "").trim().toLowerCase();
      if (q) {
        const hay = this._brToSpace((r && r.content) || "").toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    }

    /* 内容列的搜索高亮：把命中的片段包一层 mark（不分大小写，逐处都标）。
       先按原文定位再分段转义，保证用户内容里有 < > & 也不会破结构。 */
    _calTableHighlight(text, query) {
      const raw = String(text == null ? "" : text);
      const q = (query || "").trim().toLowerCase();
      if (!q) return escapeHtml(raw);
      const hay = raw.toLowerCase();
      let out = "";
      let i = 0;
      while (i < raw.length) {
        const hit = hay.indexOf(q, i);
        if (hit < 0) {
          out += escapeHtml(raw.slice(i));
          break;
        }
        out += escapeHtml(raw.slice(i, hit));
        out += `<mark class="north-caltab-table-mark">${escapeHtml(
          raw.slice(hit, hit + q.length)
        )}</mark>`;
        i = hit + q.length;
      }
      return out;
    }

    /* 表格视图的 HTML。返回 { count, html } —— 条数交给工具栏标题用。
       日期倒序（离今天近的排上面，对齐参考图），同一天内按时间正序。
       工具行的搜索 / 筛选在这里生效：先逐日过滤行，整天都被筛空的日期
       连分组头一起不出现，标题里的条数也跟着变成筛完的数量。 */
    _buildCalendarTableHtml(byDate, monthAnchor) {
      const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
      const y = monthAnchor.getFullYear();
      const m = monthAnchor.getMonth();
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      const dates = [];
      for (let d = 1; d <= daysInMonth; d++) {
        const key = this._calKey(new Date(y, m, d));
        if (byDate[key] && byDate[key].length) dates.push(key);
      }
      dates.reverse();

      const unit = this._calUnit();
      /* 搜索 + 筛选：先过滤再分组再计数，保证「标题条数 = 表里行数」 */
      const days = dates
        .map((key) => ({
          key,
          rows: this._calDayRows(
            (byDate[key] || []).filter((r) => this._calTableRecordMatch(r, key))
          ),
        }))
        .filter((d) => d.rows.length);
      const count = days.reduce((n, d) => n + d.rows.length, 0);
      if (!count) {
        /* 空态分两种：这个月真的一条都没有，还是被搜索 / 筛选筛空的 ——
           后者给一句能直接照做的提示，别让人对着空白发呆 */
        const constrained =
          (this._calTabTableSearch || "").trim() ||
          this._calTabTableTimeFilter ||
          this._calTabTypeFilter.size > 0;
        /* 空态文案与「当天弹窗」同一套措辞：量词换成文档时切掉首字（篇文档→文档） */
        return {
          count: 0,
          html: `<div class="north-caltab-table"><div class="north-caltab-table-empty">${escapeHtml(
            constrained
              ? "没有匹配的记录，试试清空搜索或筛选"
              : `这一个月还没有${unit.slice(1)}`
          )}</div></div>`,
        };
      }

      const collapsed = this._calTabTableCollapsed;
      const body = days
        .map(({ key, rows }) => {
          const day = new Date(`${key}T00:00:00`);
          const dayMin = rows.reduce((n, x) => n + (x.dur || 0), 0);
          const isToday = key === this._calKey(new Date());
          const isCollapsed = collapsed && collapsed.has(key);
          /* 分组头 = 折叠箭头 + 日期图标 + 日期星期（左）＋ 条数 / 当天合计时长（右）。
             整条带子**只干一件事：展开 / 收起**（用户明确要求，不要跳转）——
             所以带子本身就是折叠开关，不挂 data-cal-id。
             日期图标取「这一天对应文档」的图标颜色（docColor，见 _queryLifeLogDockRecords
             与 _queryCalendarDocs）；取不到就退回主色，不会变成无色。
             td 必须留在 table-cell 上（吸顶要靠它），左右分栏交给里面这层 flex。 */
          const first = rows.find((x) => x.record);
          const rec = first ? first.record : null;
          /* 这一天对应的文档：图标与颜色都取文档自己的。
             文档源记录的 icon/color 本来就是「这篇文档的」，直接可用；
             记录源是 join 出来的 docIcon/docColor。两种数据源共用一个取值口。 */
          const docColor = rec
            ? rec.docColor || (rec.icon ? rec.color || "" : "")
            : "";
          const docIcon = rec ? rec.docIcon || rec.icon || "" : "";
          const docTitle = rec && rec.docTitle ? rec.docTitle : "";
          /* 图标两态：emoji 码位（`1f4d5`）直接渲染成那个 emoji —— 那才是文档自己的图标；
             图片路径（material/xx.svg）没法稳定取到 URL，退回日历字形、只借用它的颜色。
             都没有就还是日历字形 + 主色，不会变成空白。 */
          const isEmoji = /^[0-9a-f]{1,8}$/i.test(docIcon);
          let iconHtml = "";
          if (isEmoji) {
            try {
              iconHtml = `<span class="north-caltab-table-gicon north-caltab-table-gemoji">${escapeHtml(
                String.fromCodePoint(parseInt(docIcon, 16))
              )}</span>`;
            } catch (e) {
              iconHtml = "";
            }
          }
          if (!iconHtml) {
            iconHtml = `<svg class="north-caltab-table-gicon"${
              docColor ? ` style="color:${escapeHtml(docColor)}"` : ""
            } viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><use xlink:href="#iconCalendar"></use></svg>`;
          }
          const tip = `${key} ${WD[day.getDay()]} · ${rows.length} ${unit}${
            dayMin ? ` · 共 ${this._fmtStatsDur(dayMin)}` : ""
          }${docTitle && docTitle !== key ? ` · ${docTitle}` : ""}`;
          const chevron = isCollapsed
            ? `<svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><use xlink:href="#iconRight"></use></svg>`
            : `<svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><use xlink:href="#iconDown"></use></svg>`;
          const head = `<tr class="north-caltab-table-group${
            isToday ? " is-today" : ""
          }${isCollapsed ? " is-collapsed" : ""}" data-tip="${escapeHtml(tip)}"><td colspan="4"${
            docColor ? ` style="--tt-doc-c:${escapeHtml(docColor)}"` : ""
          }>
                        <div class="north-caltab-table-gwrap" data-caltab-table-toggle="${escapeHtml(
                          key
                        )}">
                            <span class="north-caltab-table-gleft">
                                <span class="north-caltab-table-gchev">${chevron}</span>
                                ${iconHtml}
                                <span class="north-caltab-table-gdate">${escapeHtml(key)} ${
            WD[day.getDay()]
          }</span>
                            </span>
                            <span class="north-caltab-table-gmeta">${rows.length} ${escapeHtml(
            unit
          )}${dayMin ? ` · 共 ${this._fmtStatsDur(dayMin)}` : ""}</span>
                        </div>
                    </td></tr>`;
          const trs = rows
            .map((x) => {
              const r = x.record;
              /* 类型色点复用取色入口；悬停气泡的文案与时间轴事件块一字不差 */
              const c = this._calRecordColor(r);
              const hint = this._iconHint(r);
              const tip = `${r.time || ""} ${r.type || ""}：${this._brToSpace(
                r.content
              )}${hint ? ` (${hint})` : ""}`.trim();
              const typeName = (r.type || "").trim();
              /* 时间列：能算出区间就给区间（与时间轴同一口径）；
                 当天首 / 末条没有参照，只写记录里那个节点时间，不编端点出来 */
              const timeText = !x.range
                ? (r.time || "").trim() || "—"
                : x.hasRange
                ? `${this._fmtMin(x.start)} - ${this._fmtMin(x.end)}`
                : this._fmtMin(x.range.start);
              return `<tr class="north-caltab-table-row"${
                r.id ? ` data-cal-id="${escapeHtml(r.id)}"` : ""
              } data-tip="${escapeHtml(tip)}">
                        <td class="north-caltab-table-time">${escapeHtml(timeText)}</td>
                        <td class="north-caltab-table-type">${
                          typeName
                            ? `<span class="north-caltab-table-typepill" style="--tt-c:${
                                c || DEFAULT_TYPE_COLOR
                              }">${escapeHtml(typeName)}</span>`
                            : `<span class="north-caltab-table-none">—</span>`
                        }</td>
                        <td class="north-caltab-table-content">${this._calTableHighlight(
                          this._brToSpace(r.content || ""),
                          this._calTabTableSearch
                        )}</td>
                        <td class="north-caltab-table-dur">${
                          x.dur ? this._fmtStatsDur(x.dur) : "—"
                        }</td>
                    </tr>`;
            })
            .join("");
          /* 收起的那一天只留分组头 —— 表头 / 分组头的吸顶不受影响（它们还在） */
          return head + (isCollapsed ? "" : trs);
        })
        .join("");

      return {
        count,
        html: `<div class="north-caltab-table">
                    <table class="north-caltab-table-tbl">
                        <colgroup>${CAL_TABLE_COLS.map((c) =>
                          c.width ? `<col style="width:${c.width}">` : "<col>"
                        ).join("")}</colgroup>
                        <thead><tr>${CAL_TABLE_COLS.map(
                          (c) =>
                            `<th${
                              c.num ? ' class="north-caltab-table-dur"' : ""
                            }><svg class="north-caltab-table-thicon" viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><use xlink:href="#${
                              c.icon
                            }"></use></svg>${c.label}</th>`
                        ).join("")}</tr></thead>
                        <tbody>${body}</tbody>
                    </table>
                </div>`,
      };
    }

    /* ============================================================
       习惯视图（表格旁边的段位）：把「记录类型」当习惯来追踪
       设置里挑中的每个类型 = 一张卡：标题 + 四个数字 + 一整年的格子。
       年格子 = 12 个月横向并排，每个月一小块「列＝周、行＝星期（日→六）」的日历
       （补齐首日前的空位后交给 CSS 的 grid-auto-flow: column 排，见样式表）。
       格子上色按目标模型（单位 × 方向 × 周期 × 目标值，见文件头「习惯视图」说明）：
       日目标比当天值与目标的倍数（坏习惯反过来，超标才上色）；
       周 / 月目标比周期内累计进度的步进带。5 级色全部自动推导，不用手填档位。
       没记录的日子只留一层淡底；格子可点 → 跳到那天的日视图。
       数据用**全量记录**（不走工具栏的类型筛选）：筛选问的是「这屏看哪些记录」，
       习惯页问的是「我挑的这几个类型这一年怎么样」—— 被筛掉就看不见自己了。
       ============================================================ */

    /* 设置里挑中的习惯类型名单；顺手清掉空串与重复 */
    _habitTypes() {
      const raw = Array.isArray(this.data.habitTypes) ? this.data.habitTypes : [];
      const seen = new Set();
      const list = [];
      raw.forEach((t) => {
        const name = String(t == null ? "" : t).trim();
        if (name && !seen.has(name)) {
          seen.add(name);
          list.push(name);
        }
      });
      return list;
    }

    /* 某个习惯的目标模型：{ unit, dir, period, goalUnit, goal, alias, group }。
       读取时统一规范化；**老配置在这里就地迁移**（不写盘，下一次保存自然落成新格式）：
       - 旧「target < 7」（每周 N 天）→ 周目标 + 天数计法 + 目标 N 天；
       - 旧「target = 7」（每天）→ 日目标 + 合合计 + 目标取旧阶梯第一档非空门槛
         （取不到按单位兜底：次数 1 次、分钟 30 分）—— 旧的 5 级色
         「≥1/2/3/4/5 × 门槛」和新的「≥k × 目标」完全一致，热力图不跳变。 */
    _habitConfig(type) {
      const all =
        this.data.habitConfig && typeof this.data.habitConfig === "object"
          ? this.data.habitConfig
          : {};
      const raw = all[type] && typeof all[type] === "object" ? all[type] : {};
      const unit = raw.unit === "min" ? "min" : "count";
      const dir = raw.dir === "bad" ? "bad" : "good";
      /* 别名：只影响习惯卡上显示的名字（类型名是数据层的，改不得）；
         留空就用类型名本身。 */
      const alias = String(raw.alias == null ? "" : raw.alias).trim();
      /* 分组：习惯设置里可把习惯归进某个组。存的是组名引用 ——
         引用了不存在的组（改名没跟上、组已删）一律按「未分组」算。 */
      const group = String(raw.group == null ? "" : raw.group).trim();

      let period = "day";
      let goalUnit = "value";
      let goal = 0;
      if (
        raw.period === "day" ||
        raw.period === "week" ||
        raw.period === "month"
      ) {
        /* 新格式：直接取 */
        period = raw.period;
        goalUnit = raw.goalUnit === "days" ? "days" : "value";
        const g = +raw.goal;
        goal = g > 0 ? g : HABIT_GOAL_DEFAULT[unit];
      } else {
        /* 老格式迁移：target = 每周几天（1..7） */
        const legacyTarget = +raw.target;
        if (legacyTarget >= 1 && legacyTarget < 7) {
          period = "week";
          goalUnit = "days";
          goal = Math.round(legacyTarget);
        } else {
          period = "day";
          const src = Array.isArray(raw.steps) ? raw.steps : [];
          const hit = src.find((t) => t !== "" && t != null && +t > 0);
          goal = hit ? +hit : HABIT_GOAL_DEFAULT[unit];
        }
      }
      if (period === "day") goalUnit = "value";
      goal = Math.max(1, Math.min(99999, Math.round(goal * 100) / 100));

      /* 浅档：等级 1 格子的浓度覆盖（"" = 标准 22%，"mid" = 32%，"deep" = 45%）。
         打卡一次就达标的习惯（每天 ≥ 1 次）全年都落在等级 1，标准色偏浅，
         让每个习惯自己决定要不要加深 —— 不影响别的习惯。 */
      const lv1 = raw.lv1 === "mid" || raw.lv1 === "deep" ? raw.lv1 : "";

      /* 时间范围：YYYY-MM-DD 字符串，一头没填 = 那头不限；两头都没填 = 一直都在。
         写反了（开始晚于结束）自动对调；老配置没有这两个字段，读出来就是空 —— 零迁移。 */
      const mkDay = (s) => {
        const m = String(s == null ? "" : s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
      };
      let start = mkDay(raw.start);
      let end = mkDay(raw.end);
      if (start && end && start > end) {
        const t = start;
        start = end;
        end = t;
      }

      return { unit, dir, period, goalUnit, goal, alias, group, lv1, start, end };
    }

    /* 写回某个习惯的目标模型（_persist 存的是整份 settings，新键自动落盘）。
       只写新格式字段 —— 旧的 target / steps 在下一次保存后自然消失。 */
    _habitSetConfig(type, cfg) {
      const all = Object.assign({}, this.data.habitConfig || {});
      const g = +cfg.goal;
      /* 时间范围：只认 YYYY-MM-DD，写反自动对调，非法值当「不限」 */
      const mkDay = (s) => {
        const m = String(s == null ? "" : s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
      };
      let start = mkDay(cfg.start);
      let end = mkDay(cfg.end);
      if (start && end && start > end) {
        const t = start;
        start = end;
        end = t;
      }
      all[type] = {
        unit: cfg.unit === "min" ? "min" : "count",
        dir: cfg.dir === "bad" ? "bad" : "good",
        period:
          cfg.period === "week" || cfg.period === "month" ? cfg.period : "day",
        goalUnit:
          cfg.period !== "day" && cfg.goalUnit === "days" ? "days" : "value",
        goal: g > 0 ? Math.min(99999, Math.round(g * 100) / 100) : HABIT_GOAL_DEFAULT[cfg.unit === "min" ? "min" : "count"],
        alias: String(cfg.alias == null ? "" : cfg.alias).trim(),
        group: String(cfg.group == null ? "" : cfg.group).trim(),
        lv1: cfg.lv1 === "mid" || cfg.lv1 === "deep" ? cfg.lv1 : "",
        start,
        end,
      };
      this.data.habitConfig = all;
      this._persist("保存习惯目标");
    }

    /* ===================== 习惯分组 ===================== */

    /* 分组名列表：去空、去重、保序（this.data.habitGroups 存的就是名字数组） */
    _habitGroupList() {
      const raw = Array.isArray(this.data.habitGroups)
        ? this.data.habitGroups
        : [];
      const seen = new Set();
      const list = [];
      raw.forEach((n) => {
        const name = String(n == null ? "" : n).trim();
        if (name && !seen.has(name)) {
          seen.add(name);
          list.push(name);
        }
      });
      return list;
    }

    /* 某个习惯归在哪个组；组名失效（组被删 / 改名没跟上）按「未分组」算，
       不会在习惯页里冒出一个幽灵分组头。 */
    _habitGroupOf(type) {
      const cfg = this.data.habitConfig && this.data.habitConfig[type];
      const name = String((cfg && cfg.group) == null ? "" : cfg.group).trim();
      return this._habitGroupList().indexOf(name) >= 0 ? name : "";
    }

    /* 把习惯收进 / 移出分组：group 为空 = 未分组 */
    _habitSetGroup(type, group) {
      const name = String(group == null ? "" : group).trim();
      const cfg = this._habitConfig(type);
      cfg.group = name;
      this._habitSetConfig(type, cfg);
    }

    /* 某个分组的鼓励语 / 说明。说明单独存一张映射表（habitGroupDescs：
       组名 → 文案），不混进 habitGroups 名单里 —— 名单继续只存名字，
       老数据不用迁移；键随组改名 / 删组同步搬运。配过才有值。 */
    _habitGroupDesc(name) {
      const all =
        this.data.habitGroupDescs &&
        typeof this.data.habitGroupDescs === "object"
          ? this.data.habitGroupDescs
          : {};
      return String(all[name] == null ? "" : all[name]).trim();
    }

    /* 某分组在习惯页是否展开。默认收成紧凑卡，点卡才展开成全年热力；
       状态存 habitGroupExpanded（组名 → true），随设置落盘、下次回来保持。 */
    _habitGroupOpen(name) {
      const all = this.data.habitGroupExpanded;
      return !!(all && typeof all === "object" && all[name]);
    }

    /* 可挑的类型 = 数据里**实际出现过**的类型（与工具栏筛选面板同一份口径），
       按条数从多到少排；一条记录都没有的类型挑来也没意义。 */
    _habitCandidates() {
      const count = new Map();
      (this._calSourceRecords() || []).forEach((r) => {
        const t = ((r && r.type) || "").trim();
        if (t) count.set(t, (count.get(t) || 0) + 1);
      });
      return Array.from(count.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
        .map(([name, cnt]) => ({
          name,
          cnt,
          color: this._colorOf(name) || DEFAULT_TYPE_COLOR,
        }));
    }

    /* 习惯视图「范围」模式的窗口：把起止日期串（YYYY-MM-DD）解析成 Date 与标题。
       没配过（或没配全）就给默认「本月 1 日 ~ 月末」（整月，与卡片上「查看窗口」
       的「本月」预设口径一致）；起止颠倒时自动对调，用户在两个输入框里先填了
       靠后的日期也不会显示成空白。 */
    _habitRangeWindow() {
      const mk = (s) => {
        const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
      };
      const today = new Date();
      /* 范围存在插件数据里（this.data.habitRange，落盘持久）——
         重启思源、重开插件都还在，除非用户自己改 / 重置。 */
      const r = this.data.habitRange || {};
      let s = mk(r.start);
      let e = mk(r.end);
      /* 默认给整月（月末那一天 = 下个月的第 0 天）。本月还没过完时，
         尾巴上的日子在格子里会被压淡，一眼看得出是「未来」而不是「没记录」。 */
      if (!s) s = new Date(today.getFullYear(), today.getMonth(), 1);
      if (!e) e = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      if (s.getTime() > e.getTime()) {
        const t = s;
        s = e;
        e = t;
      }
      const fk = (d) =>
        d.getFullYear() +
        "-" +
        String(d.getMonth() + 1).padStart(2, "0") +
        "-" +
        String(d.getDate()).padStart(2, "0");
      return {
        start: s,
        end: e,
        startKey: fk(s),
        endKey: fk(e),
        label: `${s.getMonth() + 1}月${s.getDate()}日 ~ ${e.getMonth() + 1}月${e.getDate()}日`,
      };
    }

    /* ============ 习惯自己的「查看窗口」============
       背景：顶上那排段位（日 / 周 / 月 / 年 / 范围）原来只有一个，改一下所有习惯
       都跟着变。但每个习惯想看的时段本来就不一样 —— 打卡想看「近 100 天」，
       另一个只看「本月」。所以这里给**每个习惯**存一份自己的窗口。

       两层分工（别搞混）：
       - 顶部段位管**形态**（日卡 / 周条 / 月历 / 年热力 / 范围流式格），整屏一致；
       - 这份窗口只管**范围模式下自己那一段**，没配过就用顶部那对全局日期。
       所以配过窗口的习惯照样跟着段位换形态，切到月视图就是月视图。

       存的是**预设名**（month / d7 / d100…）而不是死日期，所以「本月」到了
       下个月自动就是新的一月；只有「自定义」才把起止日期落成字符串。 */

    /* 预设名 → 具体起止（相对「今天」现算） */
    _habitViewPresetRange(preset) {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const back = (n) => {
        const d = new Date(today);
        d.setDate(d.getDate() + n);
        return d;
      };
      if (preset === "month") {
        /* 一整月：月初到**月末**（不是到今天就截断）—— 看的是「这个月我坚持得
           怎么样」，右边还能顺带看出这个月还剩几天。口径与顶部全局范围的默认值
           完全一致，同一个「本月」在两处是同一个意思。
           过完的日子照常上色；还没到的日子由 mkRange 挂 is-future 压淡。 */
        return {
          start: new Date(now.getFullYear(), now.getMonth(), 1),
          end: new Date(now.getFullYear(), now.getMonth() + 1, 0),
        };
      }
      if (preset === "prevMonth") {
        const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        return {
          start: first,
          end: new Date(first.getFullYear(), first.getMonth() + 1, 0),
        };
      }
      if (preset === "d7") return { start: back(-6), end: today };
      if (preset === "d30") return { start: back(-29), end: today };
      if (preset === "d100") return { start: back(-99), end: today };
      return null;
    }

    /* 某个习惯自己的查看窗口：{ preset, start, end, startKey, endKey, label }；
       null = 跟随顶部。自定义的起止写反了自动对调（与全局范围同一套宽容度）。 */
    _habitViewRange(type) {
      const all =
        this.data.habitViews && typeof this.data.habitViews === "object"
          ? this.data.habitViews
          : {};
      const raw = all[type];
      if (!raw || typeof raw !== "object") return null;
      const mk = (s) => {
        const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
      };
      const fk = (d) =>
        d.getFullYear() +
        "-" +
        String(d.getMonth() + 1).padStart(2, "0") +
        "-" +
        String(d.getDate()).padStart(2, "0");
      const preset = String(raw.preset || "");
      let s;
      let e;
      let label;
      if (preset === "custom") {
        s = mk(raw.start);
        e = mk(raw.end);
        /* 只填了一头（还没选另一头）时按「跟随顶部」算，不画半个窗口 */
        if (!s || !e) return null;
        label = `${s.getMonth() + 1}月${s.getDate()}日 ~ ${e.getMonth() + 1}月${e.getDate()}日`;
      } else {
        const p = this._habitViewPresetRange(preset);
        if (!p) return null;
        s = p.start;
        e = p.end;
        label = HABIT_VIEW_LABEL[preset] || "自定义";
      }
      if (s.getTime() > e.getTime()) {
        const t = s;
        s = e;
        e = t;
      }
      return {
        preset,
        start: s,
        end: e,
        startKey: fk(s),
        endKey: fk(e),
        label,
      };
    }

    /* 写 / 清某个习惯的查看窗口。preset 为空 = 清掉这份记录，回到「跟随顶部」；
       custom 要一并给 start / end（YYYY-MM-DD）。落盘走 _persist，
       重启思源、重开插件都还在。 */
    _habitSetView(type, preset, start, end) {
      const all = Object.assign({}, this.data.habitViews || {});
      if (!preset) delete all[type];
      else if (preset === "custom") {
        all[type] = {
          preset: "custom",
          start: String(start || ""),
          end: String(end || ""),
        };
      } else all[type] = { preset };
      this.data.habitViews = all;
      this._persist("保存习惯查看窗口");
    }

    /* 某习惯在指定窗口里的每日表现：跨年窗口把涉及的那几年数据合起来。
       _habitYearData 一次只给一年，而 _habitRowsByDate 已经按年做了缓存，
       所以跨年最多多走一两次分组，不贵。合计（条数 / 时长）只数窗口内的日子 ——
       卡片头上那行「N 条 · 共 X」说的就是「这一段里有多少」，与窗口对得上。 */
    _habitRangeData(type, win) {
      const days = {};
      for (let y = win.start.getFullYear(); y <= win.end.getFullYear(); y++) {
        Object.assign(days, this._habitYearData(type, y).days);
      }
      let totalCnt = 0;
      let totalMin = 0;
      const len = Math.round((win.end - win.start) / 86400000) + 1;
      for (let i = 0; i < len; i++) {
        const r = days[this._calKey(new Date(win.start.getTime() + i * 86400000))];
        if (!r) continue;
        totalCnt += r.cnt || 0;
        totalMin += r.min || 0;
      }
      return { days, totalCnt, totalMin };
    }

    /* 一年的「日期 → 带时长的行」算一次缓存起来，几个习惯共用。
       _calDayRows 的结果与类型无关（它按整天的记录顺序算时长），所以没必要
       每个习惯各算一遍；缓存的失效靠两个身份判断：年份 + 数据数组本身
       （数据一重拉就是新数组，_calSourceRecords() 返回的引用会变）。 */
    _habitRowsByDate(year) {
      const src = this._calSourceRecords() || [];
      /* 缓存身份三家：年份 + 数据数组本身 + 当前时间计算模式。
         时长口径跟着模式走，换了模式必须整份重算，不能沿用上一套。 */
      const mode = this._timeCalcMode();
      const cache = this._habitRowsCache;
      if (cache && cache.year === year && cache.src === src && cache.mode === mode) {
        return cache.map;
      }
      const byDate = this._groupByDate(src);
      const map = {};
      for (let m = 0; m < 12; m++) {
        const dim = new Date(year, m + 1, 0).getDate();
        for (let d = 1; d <= dim; d++) {
          const key = this._calKey(new Date(year, m, d));
          const all = byDate[key];
          if (all && all.length) map[key] = this._calDayRows(all);
        }
      }
      this._habitRowsCache = { year, src, mode, map };
      return map;
    }

    /* 某类型一年里每天的表现：{ days: {日期键: {cnt, min}}, totalCnt, totalMin }
       时长口径就是上面那份缓存（= _calDayRows，跟着「时间计算模式」走：
       显式区间优先，结束模式算「上一条 → 本条」，开始模式算「本条 → 下一条」），
       再按类型挑出属于这个习惯的行。
       时间范围也在这里一处拦：范围外的记录直接不算 —— 热力图、连续、总计、
       周 / 月卡全都吃这份数据，改这一处就够，不会出现两套口径。 */
    _habitYearData(type, year) {
      const cfg = this._habitConfig(type);
      const map = this._habitRowsByDate(year);
      const days = {};
      let totalCnt = 0;
      let totalMin = 0;
      Object.keys(map).forEach((key) => {
        let cnt = 0;
        let min = 0;
        map[key].forEach((row) => {
          const t = row.record && row.record.type ? String(row.record.type).trim() : "";
          if (t !== type) return;
          if (this._habitOffState(cfg, key)) return;
          cnt += 1;
          min += row.dur || 0;
        });
        if (cnt) {
          days[key] = { cnt, min };
          totalCnt += cnt;
          totalMin += min;
        }
      });
      return { days, totalCnt, totalMin };
    }

    /* 当天该习惯的「成绩值」：按次数或累计分钟（没有记录 = 0） */
    _habitDayValue(days, key, cfg) {
      const r = days[key];
      if (!r) return 0;
      return cfg.unit === "min" ? r.min || 0 : r.cnt || 0;
    }

    /* 某天在不在习惯的时间范围内：0 = 在范围内（或没设范围），
       -1 = 还没开始，1 = 已结束。日期键是 YYYY-MM-DD，字符串直接比大小就是对的。
       只用来做**展示**（压淡格子 / 改气泡）—— 统计过滤在 _habitYearData 里做。 */
    _habitOffState(cfg, key) {
      if (cfg.start && key < cfg.start) return -1;
      if (cfg.end && key > cfg.end) return 1;
      return 0;
    }

    /* 一段周期（从 start 起 len 天）的累计：合计型累计次数 / 分钟，
       天数型累计「记了几天」。未来的日子在数据里不存在，天然只数到今天。 */
    _habitPeriodSum(days, cfg, start, len) {
      let c = 0;
      for (let i = 0; i < len; i++) {
        const v = this._habitDayValue(
          days,
          this._calKey(new Date(start.getTime() + i * 86400000)),
          cfg
        );
        c += cfg.goalUnit === "days" ? (v > 0 ? 1 : 0) : v;
      }
      return c;
    }

    /* 一个周期的累计是否达标：好习惯 ≥ 目标 / 坏习惯 < 目标（没记录 = 0 也算达标） */
    _habitPeriodAchieved(cfg, cum) {
      return cfg.dir === "bad" ? cum < cfg.goal : cum >= cfg.goal;
    }

    /* 年热力格的等级（0~5）。日目标看当天值与目标的倍数（坏习惯反过来：
       达标不上色，超出才上色，超得越多越深）；周 / 月目标看周期内累计进度的
       步进带（>0 = 1、≥25% = 2、≥50% = 3、≥75% = 4、≥100% = 5）。 */
    _habitLevelOf(cfg, value, cum) {
      const g = cfg.goal || 1;
      if (cfg.period === "day") {
        if (value <= 0) return 0;
        if (cfg.dir === "bad" && value < g) return 0;
        return Math.min(5, Math.max(1, Math.ceil(value / g)));
      }
      const ratio = cum / g;
      if (ratio <= 0) return 0;
      if (ratio >= 1) return 5;
      if (ratio >= 0.75) return 4;
      if (ratio >= 0.5) return 3;
      if (ratio >= 0.25) return 2;
      return 1;
    }

    /* 周期统计（习惯卡内「本周 / 本月」两行用）。
       返回 { check: 打卡天数, total: 累计值, rate: 完成率%, miss: 未达标期数, days: 已过天数 }。
       完成率可为负、可超 100%：好习惯 = 累计 ÷ 目标（翻倍 = 200%）；
       坏习惯 = 1 - 累计 ÷ 目标（压线 = 0%，超标一倍 = -100%）。
       结算单元 = 习惯自己的周期：日目标按天结算（今天没过完不算）；
       周 / 月目标按完整周期结算，没结完的当前期只算进度、不计入未达标。
       单元比周期还长时（月习惯看「本周」行），完成率 / 未达标不适用，返回 null。 */
    _habitPeriodStats(days, cfg, pStart, pLen, now) {
      const one = 86400000;
      const t0 = new Date(now);
      t0.setHours(0, 0, 0, 0);
      const elapsed = Math.max(
        0,
        Math.min(pLen, Math.round((t0 - pStart) / one) + 1)
      );
      const val = (i) =>
        this._habitDayValue(
          days,
          this._calKey(new Date(pStart.getTime() + i * one)),
          cfg
        );
      let check = 0;
      let total = 0;
      for (let i = 0; i < elapsed; i++) {
        const v = val(i);
        if (v > 0) check += 1;
        total += v;
      }
      const goal = cfg.goal || 1;
      const ratioOf = (cum) =>
        cfg.dir === "bad" ? 1 - cum / goal : cum / goal;
      /* 天数计法的「累计」是天数（有记录 +1），不是次数 / 分钟 */
      const cumOf = (i) =>
        cfg.period !== "day" && cfg.goalUnit === "days"
          ? val(i) > 0
            ? 1
            : 0
          : val(i);

      let rate = null;
      let miss = null;
      if (cfg.period === "day") {
        /* 日目标：单元 = 天。今天还在过，只结算今天之前的日子 */
        const settled = Math.max(0, elapsed - 1);
        miss = 0;
        if (settled > 0) {
          let s = 0;
          for (let i = 0; i < settled; i++) {
            s += ratioOf(val(i));
            if (!this._habitPeriodAchieved(cfg, val(i))) miss += 1;
          }
          rate = Math.round((s / settled) * 100);
        } else {
          rate = Math.round(ratioOf(val(0)) * 100);
        }
      } else if (cfg.period === "week") {
        /* 周目标：单元 = 周。只有**完整落在本周期内**且不晚于当前周的周才结算 */
        const wkMap = new Map();
        for (let i = 0; i < elapsed; i++) {
          const d = new Date(pStart.getTime() + i * one);
          const wk = this._calKey(this._calTabWeekStartDate(d));
          if (!wkMap.has(wk)) wkMap.set(wk, { start: i, cum: 0, full: false });
          wkMap.get(wk).cum += cumOf(i);
        }
        wkMap.forEach((info) => {
          const ws = this._calTabWeekStartDate(
            new Date(pStart.getTime() + info.start * one)
          );
          info.full = ws.getTime() + 7 * one <= pStart.getTime() + pLen * one;
        });
        const curKey = this._calKey(this._calTabWeekStartDate(t0));
        let s = 0;
        let n = 0;
        miss = 0;
        wkMap.forEach((info, key) => {
          if (key === curKey || !info.full) return;
          s += ratioOf(info.cum);
          n += 1;
          if (!this._habitPeriodAchieved(cfg, info.cum)) miss += 1;
        });
        if (n > 0) rate = Math.round((s / n) * 100);
        else {
          const cur = wkMap.get(curKey);
          rate = Math.round(ratioOf(cur ? cur.cum : 0) * 100);
        }
      } else {
        /* 月目标：本周期本身就是当月，只有进度没有结算 */
        let cum = 0;
        for (let i = 0; i < elapsed; i++) cum += cumOf(i);
        rate = Math.round(ratioOf(cum) * 100);
        miss = 0;
      }
      return { check, total, rate, miss, days: elapsed };
    }

    /* 当前连续：按各自周期结算 —— 日目标数天、周目标数周、月目标数月。
       本期还没达成不算断（从上一期接着数）；坏习惯「还没超标 = 达标」。
       返回 { n, unit }，unit 是「天 / 周 / 月」，显示时直接用。 */
    _habitStreak(days, year, cfg) {
      const one = 86400000;
      if (cfg.period === "day") {
        const okDay = (d) =>
          this._habitPeriodAchieved(
            cfg,
            this._habitDayValue(days, this._calKey(d), cfg)
          );
        const t = new Date();
        t.setHours(0, 0, 0, 0);
        let cur = t;
        if (!okDay(cur)) cur = new Date(t.getTime() - one);
        let n = 0;
        /* 上限只是兜底：万一日后数据串成环，别在这里转死 */
        while (n < 4000 && okDay(cur)) {
          n += 1;
          cur = new Date(cur.getTime() - one);
        }
        return { n, unit: "天" };
      }
      if (cfg.period === "week") {
        const okWeek = (ws) =>
          this._habitPeriodAchieved(
            cfg,
            this._habitPeriodSum(days, cfg, ws, 7)
          );
        let cur = this._calTabWeekStartDate(new Date());
        if (!okWeek(cur)) cur = new Date(cur.getTime() - 7 * one);
        let n = 0;
        while (n < 400 && okWeek(cur)) {
          n += 1;
          cur = new Date(cur.getTime() - 7 * one);
        }
        return { n, unit: "周" };
      }
      /* 月目标：从本月往前数 */
      const okMonth = (y, m) => {
        const dim = new Date(y, m + 1, 0).getDate();
        return this._habitPeriodAchieved(
          cfg,
          this._habitPeriodSum(days, cfg, new Date(y, m, 1), dim)
        );
      };
      let cy = new Date().getFullYear();
      let cm = new Date().getMonth();
      if (!okMonth(cy, cm)) {
        cm -= 1;
        if (cm < 0) {
          cm = 11;
          cy -= 1;
        }
      }
      let n = 0;
      while (n < 400 && okMonth(cy, cm)) {
        n += 1;
        cm -= 1;
        if (cm < 0) {
          cm = 11;
          cy -= 1;
        }
      }
      return { n, unit: "月" };
    }

    /* 这一年里最长的一串：日目标数天、周目标数周、月目标数月 */
    _habitLongest(days, year, cfg) {
      let best = 0;
      let run = 0;
      const one = 86400000;
      if (cfg.period === "day") {
        const dim = Math.round(
          (new Date(year + 1, 0, 1) - new Date(year, 0, 1)) / one
        );
        for (let i = 0; i < dim; i++) {
          const d = new Date(year, 0, 1 + i);
          if (
            this._habitPeriodAchieved(
              cfg,
              this._habitDayValue(days, this._calKey(d), cfg)
            )
          ) {
            run += 1;
            if (run > best) best = run;
          } else {
            run = 0;
          }
        }
        return { n: best, unit: "天" };
      }
      if (cfg.period === "week") {
        /* 与年热力同一套网格起点（周日对齐），扫整年的周 */
        const gridStart = new Date(year, 0, 1);
        gridStart.setDate(gridStart.getDate() - gridStart.getDay());
        const total = Math.ceil(
          (Math.round((new Date(year, 11, 31) - gridStart) / one) + 1) / 7
        );
        for (let w = 0; w < total; w++) {
          const cum = this._habitPeriodSum(
            days,
            cfg,
            new Date(gridStart.getTime() + w * 7 * one),
            7
          );
          if (this._habitPeriodAchieved(cfg, cum)) {
            run += 1;
            if (run > best) best = run;
          } else {
            run = 0;
          }
        }
        return { n: best, unit: "周" };
      }
      for (let m = 0; m < 12; m++) {
        const dim = new Date(year, m + 1, 0).getDate();
        const cum = this._habitPeriodSum(days, cfg, new Date(year, m, 1), dim);
        if (this._habitPeriodAchieved(cfg, cum)) {
          run += 1;
          if (run > best) best = run;
        } else {
          run = 0;
        }
      }
      return { n: best, unit: "月" };
    }

    /* 习惯视图主体：顶部「今日完成 x / y」+ 进度条，然后一个习惯一张卡，
       最后一条**共用**的等级说明（几个习惯都是「合计时长」分级，说明一条就够）。
       视图自己带一组周期段位（日 / 周 / 月 / 年 / 范围）：年是原来的整年热力，
       其余周期把每张卡的格子区换成对应窗口的展示（月历格 / 周条 / 单日 / 流式格）。 */
    _buildCalendarHabitHtml(year) {
      const types = this._habitTypes();
      const todayKey = this._calKey(new Date());
      const now = new Date();
      /* 周期与锚点：_paintCalendarTab 已保证初始化，这里只兜底 */
      const period = this._calTabHabitPeriod || "year";
      const anchor =
        this._calTabHabitAnchor instanceof Date ? this._calTabHabitAnchor : new Date();
      const rangeWin = period === "range" ? this._habitRangeWindow() : null;
      const sicon = (id) =>
        `<svg class="north-caltab-habit-sicon" viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><use xlink:href="#${id}"></use></svg>`;

      /* 习惯头像：类型色淡底圆 + 名字首字（周列表 / 月卡头部共用） */
      const avatar = (color, label) =>
        `<span class="north-caltab-habit-avatar" style="--tt-c:${escapeHtml(
          color
        )}">${escapeHtml((label || "?").slice(0, 1))}</span>`;
      /* 时间范围状态徽标：「今天」落在范围外就直说（未开始 / 已结束），
         让「今日完成 x/y」里那枚没打勾的卡有处可查；没设范围不占位。 */
      const rangeBadge = (cfg) => {
        if (!cfg.start && !cfg.end) return "";
        if (cfg.start && todayKey < cfg.start)
          return `<span class="north-caltab-habit-rbadge">未开始</span>`;
        if (cfg.end && todayKey > cfg.end)
          return `<span class="north-caltab-habit-rbadge">已结束</span>`;
        return "";
      };
      /* 打卡点阵共用的单格内容与气泡：实心格里直接显示当天的记录条数
         （1 条也显示 1，多条显示 2、3…），其余信息（时长 / 达标情况）
         交给悬停气泡 —— 格子上只留一眼能读的。
         传了 cfg（目标模型）就顺带认「时间范围」：范围外的日子压淡，
         气泡直说「未开始 / 已结束」，不冒充「未记录」。 */
      const dotCell = (dt, raw, cls, key, cfg) => {
        const isFuture = dt > now;
        const all = cls.slice();
        if (raw && raw.cnt > 1) all.push("is-count");
        else if (raw) all.push("is-done");
        if (isFuture) all.push("is-future");
        if (key === todayKey) all.push("is-today");
        let tip = raw
          ? `${key} · ${this._fmtStatsDur(raw.min)} · ${raw.cnt} ${this._calUnit()}`
          : `${key} · 未记录`;
        const off = cfg ? this._habitOffState(cfg, key) : 0;
        if (off) {
          all.push("is-off");
          tip = `${key} · ${off < 0 ? "未开始" : "已结束"}`;
        }
        const inner = raw ? `${raw.cnt}` : "";
        return `<div class="${all.join(
          " "
        )}" data-caltab-habitday="${key}" data-tip="${escapeHtml(tip)}">${inner}</div>`;
      };

      /* 周期段位行：与顶栏视图切换同一套段位样式（.north-caltab-segments）。
         选「范围」时在右边补两个日期输入，改动即重绘（change 委托在容器上）。
         —— 这里**才是**决定看哪种形态的开关（日卡 / 周条 / 月历 / 年热力 / 范围流式格）。
         习惯卡上那枚「查看窗口」只管范围模式下自己那一段，不抢这个开关的活。
         （别在这行加 data-tip：提示气泡会压在段位上，把「周」这些按钮挡掉。） */
      const perBtn = (key, txt) =>
        `<button class="${period === key ? "active" : ""}" data-caltab-habitper="${key}">${txt}</button>`;
      let toolbarHtml = `<div class="north-caltab-habit-toolbar"><div class="north-caltab-segments north-caltab-habit-periods">${perBtn(
        "day",
        "日"
      )}${perBtn("week", "周")}${perBtn("month", "月")}${perBtn(
        "year",
        "年"
      )}${perBtn("range", "范围")}</div>`;
      /* 起止日期：两枚胶囊按钮 + 自绘日历弹层（替换原生 date 输入，
         观感与插件其它浮层一致）。弹层一次只开一个字段，
         浏览月份存在实例上（_calTabHabitRangeView）。
         scope 为空 = 改顶部那对全局日期；否则是改某张习惯卡自己的窗口
         —— 同一份日历两处共用，靠 _calTabHabitRangeScope 区分写入目标。 */
      const rangeField = (which, win, scope) => {
        const d = which === "start" ? win.start : win.end;
        const open =
          this._calTabHabitRangePick === which &&
          (this._calTabHabitRangeScope || "") === scope;
        const wd = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
        return `<button class="north-caltab-habit-rfield${
          open ? " open" : ""
        }" data-caltab-rangebtn="${which}" data-caltab-rangescope="${escapeHtml(
          scope
        )}" data-tip="选择${which === "start" ? "开始" : "结束"}日期">${
          d.getMonth() + 1
        }月${d.getDate()}日 周${wd}</button>`;
      };
      const rangeCal = (which, win, scope) => {
        if (
          this._calTabHabitRangePick !== which ||
          (this._calTabHabitRangeScope || "") !== scope
        )
          return "";
        const view =
            this._calTabHabitRangeView instanceof Date
              ? this._calTabHabitRangeView
              : new Date();
          const y = view.getFullYear();
          const m = view.getMonth();
          const selKey = which === "start" ? win.startKey : win.endKey;
          const ws = this._calWeekStart();
          const first = new Date(y, m, 1);
          const lead =
            ws === 1
              ? first.getDay() === 0
                ? 6
                : first.getDay() - 1
              : first.getDay();
          const dim = new Date(y, m + 1, 0).getDate();
          const WD = ["日", "一", "二", "三", "四", "五", "六"];
          const weekHead = Array.from(
            { length: 7 },
            (_, i) => `<span>${WD[(ws + i) % 7]}</span>`
          ).join("");
          /* 网格：首行按每周起始日留出上月尾巴，末尾补下月开头 —— 邻月日子浅灰 */
          const total = Math.ceil((lead + dim) / 7) * 7;
          const start = new Date(y, m, 1 - lead);
          let cells = "";
          for (let i = 0; i < total; i++) {
            const dt = new Date(start);
            dt.setDate(start.getDate() + i);
            const key = this._calKey(dt);
            const cls = [];
            if (dt.getMonth() !== m) cls.push("is-out");
            if (key === todayKey) cls.push("is-today");
            if (key === selKey) cls.push("is-sel");
            cells += `<button type="button" class="${cls.join(
              " "
            )}" data-caltab-rangepick="${key}">${dt.getDate()}</button>`;
          }
          return `<div class="north-caltab-habit-rcal open" data-caltab-rcal="${which}">
                    <div class="north-caltab-habit-rcal-head">
                        <button type="button" class="north-caltab-habit-rcal-arrow" data-caltab-rangenav="prev" data-tip="上个月"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><use xlink:href="#iconLeft"></use></svg></button>
                        <span class="north-caltab-habit-rcal-title">${y}年${m + 1}月</span>
                        <button type="button" class="north-caltab-habit-rcal-arrow" data-caltab-rangenav="next" data-tip="下个月"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><use xlink:href="#iconRight"></use></svg></button>
                    </div>
                    <div class="north-caltab-habit-rcal-week">${weekHead}</div>
                    <div class="north-caltab-habit-rcal-grid">${cells}</div>
                </div>`;
      };
      if (period === "range") {
        toolbarHtml += `<div class="north-caltab-habit-range">${rangeField(
          "start",
          rangeWin,
          ""
        )}<span class="north-caltab-habit-range-sep">至</span>${rangeField(
          "end",
          rangeWin,
          ""
        )}${rangeCal("start", rangeWin, "")}${rangeCal("end", rangeWin, "")}</div>`;
      }
      toolbarHtml += `</div>`;

      /* 习惯卡上那枚「查看窗口」= 这个习惯在**范围模式**下看哪一段：
         viewOf(type) → 它自己配的那一段（没配过 = null，用顶部那对全局日期）
         段位（日 / 周 / 月 / 年 / 范围）始终由**顶部**统一驱动 —— 卡片不会因为
         配过窗口就赖在范围样式上不走，切到月视图就是月视图。 */
      const viewOf = (type) => this._habitViewRange(type);

      /* 卡片头那枚「查看窗口」胶囊：点开在卡片里就地展开设置条（不做浮层 ——
         卡片网格会裁掉溢出的东西）。没配过显示「默认」。 */
      const viewChip = (type, vw) =>
        `<button class="north-caltab-habit-period${
          vw ? " is-set" : ""
        }" type="button" data-caltab-habitview="${escapeHtml(
          type
        )        }" data-tip="${
          vw
            ? "查看窗口：范围模式下这张卡只看这一段"
            : "跟随顶部全局范围，点开可单独设置"
        }">${sicon("iconCalendar")}${escapeHtml(vw ? vw.label : "默认")}</button>`;

      /* 查看窗口设置条：预设一眼全在；选「自定义」再补一对起止日期。
         起止用的是顶部那套自绘日历（靠 _calTabHabitRangeScope 区分写入目标）。 */
      const viewPanel = (type, vw) => {
        if (this._calTabHabitViewOpen !== type) return "";
        const raw = (this.data.habitViews && this.data.habitViews[type]) || {};
        const cur = String(raw.preset || "");
        /* 自定义的起止：还没落成有效窗口时先用「当前生效的那一段」兜底，
           这样点开就看到眼下正在看的日子，而不是一对空白 */
        const win = vw || this._habitRangeWindow();
        const preBtn = (o) =>
          `<button type="button" class="${
            cur === o.value ? "on" : ""
          }" data-caltab-habitvpreset="${
            o.value
          }" data-caltab-habitvtype="${escapeHtml(type)}">${o.label}</button>`;
        const custom =
          cur === "custom"
            ? `<div class="north-caltab-habit-range">${rangeField(
                "start",
                win,
                type
              )}<span class="north-caltab-habit-range-sep">至</span>${rangeField(
                "end",
                win,
                type
              )}${rangeCal("start", win, type)}${rangeCal("end", win, type)}</div>`
            : "";
        return `<div class="north-caltab-habit-vpanel">
                <span class="north-caltab-habit-vlabel">查看窗口</span>
                <span class="north-caltab-habit-vpresets">${HABIT_VIEW_PRESETS.map(
                  preBtn
                ).join("")}</span>
                <span class="north-caltab-habit-vnote">只看这一段，别的习惯各看各的</span>
                ${custom}
            </div>`;
      };

      if (!types.length) {
        return `<div class="north-caltab-habit">
                <div class="north-caltab-habit-empty">
                    <div class="north-caltab-habit-empty-title">还没有设置习惯</div>
                    <div class="north-caltab-habit-empty-desc">去「设置 → 习惯设置」里点几个记录类型，挑中的类型会在这里一个类型一张卡地追踪。</div>
                    <button class="north-caltab-habit-empty-btn" type="button" data-caltab-act="settings">去设置</button>
                </div>
            </div>`;
      }

      let doneCount = 0;
      const cardHtml = (type, vw) => {
        const color = this._colorOf(type) || DEFAULT_TYPE_COLOR;
        /* 这个习惯自己的目标模型：单位 × 方向（好/坏）× 周期（日/周/月）× 目标值 */
        const cfg = this._habitConfig(type);
        /* 卡上显示的名字：配了别名就用别名（类型名是数据层的，改不得） */
        const label = cfg.alias || type;
        /* 形态由顶部段位定（p）。范围模式下这个习惯看哪一段：自己配过就用
           自己那段（跨年的日子由 _habitRangeData 按年合并），没配过就用
           顶部那对全局日期。配过窗口**不会**把卡片锁在范围样式上。 */
        const p = period;
        const win = p === "range" ? vw || rangeWin : null;
        const vy = win ? win.end.getFullYear() : year;
        const data = win
          ? this._habitRangeData(type, win)
          : this._habitYearData(type, year);
        const { days, totalCnt, totalMin } = data;
        const dayVal = (d) => this._habitDayValue(days, this._calKey(d), cfg);
        /* 「浅档」覆盖（设置里按习惯选）：等级 1 格子的浓度内联加深，
           直接压过共用的 .tt-lv1 —— 只影响这个习惯，别的习惯照旧。
           适中 = 32%，较深 = 45%；标准 = 不加任何内联样式（22%）。 */
        const lv1Attr = (lvl) => {
          if (lvl !== 1 || !cfg.lv1) return "";
          const mix = cfg.lv1 === "deep" ? 45 : 32;
          return ` style="background:color-mix(in srgb, ${escapeHtml(
            color
          )} ${mix}%, var(--b3-theme-background))"`;
        };

        /* 某一天的展示信息：当天成绩、本期累计、等级、气泡文案。
           累计口径与年热力完全一致：周目标按周重置、月目标按月重置，
           从周期头一天累到当天 —— 月 / 周 / 范围这些非年视图的格子
           全部从这里取数，保证几种视图是同一个口径，不会各算各的。 */
        const cellInfo = (dt) => {
          const key = this._calKey(dt);
          const raw = days[key];
          const off = this._habitOffState(cfg, key);
          const v = off ? 0 : dayVal(dt);
          let cum = cfg.goalUnit === "days" ? (v > 0 ? 1 : 0) : v;
          if (off) {
            /* 范围外的日子不参与累计，气泡直说状态，不冒充「未达标」 */
            return {
              key,
              raw,
              v,
              cum,
              lvl: 0,
              off,
              tip: `${key} · ${off < 0 ? "未开始" : "已结束"}`,
            };
          }
          if (cfg.period === "week") {
            for (
              let d = new Date(this._calTabWeekStartDate(dt));
              d < dt;
              d.setDate(d.getDate() + 1)
            ) {
              const dv = dayVal(d);
              cum += cfg.goalUnit === "days" ? (dv > 0 ? 1 : 0) : dv;
            }
          } else if (cfg.period === "month") {
            for (
              let d = new Date(dt.getFullYear(), dt.getMonth(), 1);
              d < dt;
              d.setDate(d.getDate() + 1)
            ) {
              const dv = dayVal(d);
              cum += cfg.goalUnit === "days" ? (dv > 0 ? 1 : 0) : dv;
            }
          }
          const lvl = this._habitLevelOf(cfg, v, cum);
          const tip = raw
            ? `${key} · ${this._fmtStatsDur(raw.min)} · ${raw.cnt} ${this._calUnit()}`
            : `${key} · 未记录`;
          const tipTail =
            cfg.period === "day"
              ? this._habitPeriodAchieved(cfg, v)
                ? "达标"
                : "未达标"
              : `本期累计 ${fmtN(cum)}/${fmtN(cfg.goal)}`;
          return { key, raw, v, cum, lvl, off: 0, tip: `${tip} · ${tipTail}` };
        };

        /* —— 非年周期的格子区（年热力走下面原有的那段） ——
           周 / 月两个周期已改走外面的 weekCardHtml / mcardHtml（都是卡片），
           卡片本身只剩 范围 / 年热力 两种格子区（周 / 月 / 日都改走外面的卡片构建器）。 */
        /* 范围：范围内每天一格流式铺开。跨年的窗口不再留空格 ——
           数据在 _habitRangeData 里把涉及的那几年合起来了。 */
        const mkRange = (w) => {
          const len = Math.round((w.end - w.start) / 86400000) + 1;
          if (len <= 0 || len > 366)
            return `<div class="north-caltab-habit-rnote">范围无效（最长 366 天）</div>`;
          let cells = "";
          for (let i = 0; i < len; i++) {
            const dt = new Date(w.start);
            dt.setDate(w.start.getDate() + i);
            const info = cellInfo(dt);
            const valTxt =
              cfg.unit === "min" ? this._fmtStatsDur(info.v) : `${fmtN(info.v)}`;
            cells += `<div class="north-caltab-habit-rcell${
              info.lvl ? " tt-lv" + info.lvl : ""
            }${
              info.off ? " is-off" : ""
            }${
              dt > now ? " is-future" : ""
            }"${lv1Attr(info.lvl)} data-caltab-habitday="${
              info.key
            }" data-tip="${escapeHtml(
              info.tip
            )}"><span class="north-caltab-habit-rcell-date">${dt.getMonth() + 1}/${
              dt.getDate()
            }</span><b class="north-caltab-habit-rcell-val">${valTxt}</b></div>`;
          }
          return `<div class="north-caltab-habit-rgrid">${cells}</div>`;
        };

        /* 总览里这一项算不算达成：按各自周期结算 —— 日目标看今天、
           周目标看本周、月目标看本月（好习惯 ≥ 目标，坏习惯 < 目标） */
        let achieved = false;
        if (cfg.period === "day") {
          achieved = this._habitPeriodAchieved(cfg, dayVal(new Date()));
        } else if (cfg.period === "week") {
          achieved = this._habitPeriodAchieved(
            cfg,
            this._habitPeriodSum(days, cfg, this._calTabWeekStartDate(new Date()), 7)
          );
        } else {
          achieved = this._habitPeriodAchieved(
            cfg,
            this._habitPeriodSum(
              days,
              cfg,
              new Date(vy, now.getMonth(), 1),
              new Date(vy, now.getMonth() + 1, 0).getDate()
            )
          );
        }
        if (achieved) doneCount += 1;
        const streak = this._habitStreak(days, vy, cfg);
        const longest = this._habitLongest(days, vy, cfg);
        /* 「本期成绩」一行：日目标 → 本月达标天数 / 已过天数；
           周目标 → 本周累计 / 目标；月目标 → 本月累计 / 目标 */
        const fmtN = (n) => Math.round(n * 10) / 10;
        let statLabel = "本月";
        let statDone = 0;
        let statGoal = 0;
        let statSuffix = "";
        if (cfg.period === "day") {
          const elapsed = vy === now.getFullYear() ? now.getDate() : new Date(vy, now.getMonth() + 1, 0).getDate();
          let mDone = 0;
          for (let d = 1; d <= elapsed; d++) {
            if (this._habitPeriodAchieved(cfg, dayVal(new Date(vy, now.getMonth(), d)))) mDone += 1;
          }
          statDone = mDone;
          statGoal = elapsed;
          statSuffix = " 天";
        } else if (cfg.period === "week") {
          statLabel = "本周";
          statDone = this._habitPeriodSum(days, cfg, this._calTabWeekStartDate(new Date()), 7);
          statGoal = cfg.goal;
          statSuffix = cfg.goalUnit === "days" ? " 天" : "";
        } else {
          statDone = this._habitPeriodSum(
            days,
            cfg,
            new Date(vy, now.getMonth(), 1),
            new Date(vy, now.getMonth() + 1, 0).getDate()
          );
          statGoal = cfg.goal;
          statSuffix = cfg.goalUnit === "days" ? " 天" : "";
        }
        /* 格子区按周期分发：年 = 下面这段整年热力（原样保留），
           其余周期用上面几个构建器换成对应窗口的展示 */
        let heatHtml = "";
        if (p === "year") {
        /* 年格子：一整年铺成「列＝周、行＝星期日→六」，月份标在下方 ——
           版式与尺寸照抄统计视图那张「全年记录热力」（1:1 复刻 lumina 贡献图），
           只是配色换成这个习惯的类型色。年外的日子留空（透明，不占视觉）。 */
        const yearStart = new Date(vy, 0, 1);
        const gridStart = new Date(yearStart);
        /* 周日起始，与统计那张热力取周方式一致 */
        gridStart.setDate(yearStart.getDate() - yearStart.getDay());
        const weeks = Math.ceil(
          (Math.round((new Date(vy, 11, 31) - gridStart) / 86400000) + 1) / 7
        );
        const monthStart = new Array(12).fill(-1);
        const monthEnd = new Array(12).fill(-1);
        /* 周 / 月目标的格子色按「周期内累计进度」走：按时间顺序扫，
           周期键（周键 / 月键）一变就把累计清零。日目标用不到累计。 */
        let cum = 0;
        let cumKey = "";
        let heatCols = "";
        for (let w = 0; w < weeks; w++) {
          let col = "";
          for (let d = 0; d < 7; d++) {
            const dt = new Date(gridStart);
            dt.setDate(gridStart.getDate() + w * 7 + d);
            if (dt.getFullYear() !== vy) {
              col += '<i class="north-caltab-habit-cell is-blank"></i>';
              continue;
            }
            const key = this._calKey(dt);
            /* 时间范围外的日子：压淡 + 气泡直说状态（数据已在 _habitYearData 拦过，
               这里只管展示） */
            const off = this._habitOffState(cfg, key);
            /* raw = 当天的记录对象（tip 用它的次数 / 分钟）；v = 目标模型的成绩值 */
            const raw = days[key];
            const v = off ? 0 : dayVal(dt);
            /* 周期累计：周目标按周重置、月目标按月重置（日目标用不到） */
            if (cfg.period === "week") {
              const wk = this._calKey(this._calTabWeekStartDate(dt));
              if (wk !== cumKey) {
                cumKey = wk;
                cum = 0;
              }
              cum += cfg.goalUnit === "days" ? (v > 0 ? 1 : 0) : v;
            } else if (cfg.period === "month") {
              const mk = key.slice(0, 7);
              if (mk !== cumKey) {
                cumKey = mk;
                cum = 0;
              }
              cum += cfg.goalUnit === "days" ? (v > 0 ? 1 : 0) : v;
            }
            /* 这一天的等级：日目标比当天值与目标的倍数；
               周 / 月目标比周期内累计进度的步进带 */
            const lvl = this._habitLevelOf(cfg, v, cum);
            const mo = dt.getMonth();
            if (monthStart[mo] === -1) monthStart[mo] = w;
            monthEnd[mo] = w;
            const cls = ["north-caltab-habit-cell"];
            if (lvl) cls.push("tt-lv" + lvl);
            if (off) cls.push("is-off");
            const tip = off
              ? `${key} · ${off < 0 ? "未开始" : "已结束"}`
              : raw
                ? `${key} · ${this._fmtStatsDur(raw.min)} · ${raw.cnt} ${this._calUnit()}`
                : `${key} · 未记录`;
            const tipTail =
              off
                ? ""
                : cfg.period === "day"
                  ? this._habitPeriodAchieved(cfg, v)
                    ? "达标"
                    : "未达标"
                  : `本期累计 ${fmtN(cum)}/${fmtN(cfg.goal)}`;
            col += `<i class="${cls.join(
              " "
            )}"${lv1Attr(lvl)} data-caltab-habitday="${key}" data-tip="${escapeHtml(
              off ? tip : `${tip} · ${tipTail}`
            )}"></i>`;
          }
          heatCols += `<div class="north-caltab-habit-heatcol">${col}</div>`;
        }
        /* 月份标签按「那一月占的周列」居中，用百分比定位 —— 与统计热力同款算法 */
        const heatMonths = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"]
          .map((name, mi) => {
            if (monthStart[mi] === -1) return "";
            const mid = (monthStart[mi] + monthEnd[mi]) / 2;
            return `<span class="north-caltab-habit-heatmonth" style="left:${(
              ((mid + 0.5) / weeks) * 100
            ).toFixed(2)}%">${name}</span>`;
          })
          .join("");
        heatHtml = `<div class="north-caltab-habit-heat">
                    <div class="north-caltab-habit-heatcols">${heatCols}</div>
                    <div class="north-caltab-habit-heatmonths">${heatMonths}</div>
                </div>`;
        } else if (p === "range") {
          heatHtml = mkRange(win);
        }
        /* 等级说明按目标模型生成（色块用该习惯的类型色 --tt-c）：
           日目标（好）：等级k ≥ k×目标；日目标（坏）：达标 < 目标（不上色），等级k = 超标 k 倍起；
           周 / 月目标：等级1 = 有记录，等级2~5 = 本期累计 ≥25/50/75/100% 目标 */
        let legend = "";
        if (cfg.period === "day") {
          legend = [1, 2, 3, 4, 5]
            .map(
              (k) =>
                `<span><i class="north-caltab-habit-cell tt-lv${k}"${
                  k === 1 ? lv1Attr(1) : ""
                }></i>${
                  cfg.dir === "bad" ? "超标 ≥" : "≥"
                } ${habitUnitLabel(cfg.unit, fmtN(k * cfg.goal))}</span>`
            )
            .join("");
          if (cfg.dir === "bad") {
            legend =
              `<span><i class="north-caltab-habit-cell"></i>达标 &lt; ${habitUnitLabel(
                cfg.unit,
                fmtN(cfg.goal)
              )}</span>` + legend;
          }
        } else {
          const bandLabels = [
            [1, "有记录"],
            [2, "≥ 25%"],
            [3, "≥ 50%"],
            [4, "≥ 75%"],
            [5, "≥ 100%"],
          ];
          legend = bandLabels
            .map(
              ([lv, txt]) =>
                `<span><i class="north-caltab-habit-cell tt-lv${lv}"${
                  lv === 1 ? lv1Attr(1) : ""
                }></i>等级${lv} ${txt}</span>`
            )
            .join("");
          legend += `<span>（按${cfg.period === "week" ? "周" : "月"}累计${
            cfg.goalUnit === "days" ? "天数" : ""
          }，目标 ${fmtN(cfg.goal)}${cfg.goalUnit === "days" ? " 天" : ""}）</span>`;
        }
        /* 打卡进度：统计行里一项，详细统计放悬浮气泡。气泡是富文本：
           本周 / 本月各一行（药丸标签 + 数值加粗，负完成率标红）。
           只在今年显示。 */
        let pstatTip = "";
        if (vy === now.getFullYear()) {
          const line = (label, s) => {
            const avg = s.days > 0 ? s.total / s.days : 0;
            const total =
              cfg.unit === "min" ? this._fmtStatsDur(s.total) : `${fmtN(s.total)} 次`;
            const avgTxt =
              cfg.unit === "min" ? this._fmtStatsDur(avg) : `${fmtN(avg)} 次`;
            const neg = s.rate != null && s.rate < 0;
            return `<div class="tip-line"><i class="tip-tag">${label}</i>打卡 <b>${s.check}</b> 天 · 完成率 <b${
              neg ? ' class="neg"' : ""
            }>${s.rate == null ? "—" : `${s.rate}%`}</b> · 共 <b>${total}</b> · 未达标 <b>${
              s.miss == null ? "—" : s.miss
            }</b> 期 · 日均 <b>${avgTxt}</b></div>`;
          };
          const wS = this._habitPeriodStats(
            days,
            cfg,
            this._calTabWeekStartDate(new Date()),
            7,
            now
          );
          const mLen = new Date(vy, now.getMonth() + 1, 0).getDate();
          const mS = this._habitPeriodStats(
            days,
            cfg,
            new Date(vy, now.getMonth(), 1),
            mLen,
            now
          );
          pstatTip = `${line("本周", wS)}${line("本月", mS)}`;
        }
        return `<div class="north-caltab-habit-card" style="--tt-c:${escapeHtml(color)}">
                <div class="north-caltab-habit-head">
                    <span class="north-caltab-habit-name"><i class="north-caltab-habit-dot"></i>${escapeHtml(
                      label
                    )}<span class="north-caltab-habit-goal">${habitGoalText(
          cfg
        )}</span>${rangeBadge(cfg)}${p === "range" ? viewChip(type, vw) : ""}</span>
                    <span class="north-caltab-habit-stats">
                        <span>${sicon("iconPlugZap")}连续 <b>${streak.n}</b> ${streak.unit}</span>
                        <span>${sicon("iconStar")}最长 <b>${longest.n}</b> ${longest.unit}</span>
                        <span>${sicon("iconCalendar")}${statLabel} <b>${fmtN(statDone)}</b>/${fmtN(statGoal)}${statSuffix}</span>${
          pstatTip
            ? `<span class="north-caltab-habit-progress" data-tip-html="${escapeHtml(pstatTip)}"><svg class="north-caltab-habit-sicon" viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M4 20V10h3v10H4zm6.5 0V4h3v16h-3zM17 20v-7h3v7h-3z"/></svg>打卡进度</span>`
            : ""
        }
                        <span>${sicon("iconCheck")}${totalCnt} ${this._calUnit()} · 共 <b>${this._fmtStatsDur(
          totalMin
        )}</b></span>
                    </span>
                </div>
                ${p === "range" ? viewPanel(type, vw) : ""}
                <div class="north-caltab-habit-heat">${heatHtml}</div>
                ${
                  p === "year" || p === "range"
                    ? `<div class="north-caltab-habit-legend">${legend}</div>`
                    : ""
                }
            </div>`;
      };

      /* —— 周视图：一个面板、一行一个习惯（对齐参考 App 的周打卡列表） ——
         左边 = 类型色头像（名字首字）+ 名字，右边 = 7 个打卡圆点。
         头部总览的「本期达成 x/y」要继续有数：这里按各习惯自己的目标模型
         判断当前这一期是否达成，与 cardHtml 里的口径一致。 */
      const achievedNow = (type) => {
        const cfg = this._habitConfig(type);
        const { days } = this._habitYearData(type, year);
        if (cfg.period === "day") {
          return this._habitPeriodAchieved(
            cfg,
            this._habitDayValue(days, this._calKey(new Date()), cfg)
          );
        }
        if (cfg.period === "week") {
          return this._habitPeriodAchieved(
            cfg,
            this._habitPeriodSum(days, cfg, this._calTabWeekStartDate(new Date()), 7)
          );
        }
        return this._habitPeriodAchieved(
          cfg,
          this._habitPeriodSum(
            days,
            cfg,
            new Date(year, now.getMonth(), 1),
            new Date(year, now.getMonth() + 1, 0).getDate()
          )
        );
      };
      /* —— 周视图：一个习惯一张卡（与月卡同一套卡片语言） ——
         头 = 头像 + 名字 + 目标小字；身 = 7 列打卡圆点（每列圆点 + 星期小字）；
         脚 = 本周打卡 / 达标天数。顶部总览的「本期达成 x/y」继续有数。 */
      const weekCardHtml = (type) => {
        const color = this._colorOf(type) || DEFAULT_TYPE_COLOR;
        const cfg = this._habitConfig(type);
        const label = cfg.alias || type;
        const { days } = this._habitYearData(type, year);
        const dayVal = (d) => this._habitDayValue(days, this._calKey(d), cfg);
        const WD = ["日", "一", "二", "三", "四", "五", "六"];
        const w0 = this._calTabWeekStartDate(anchor);
        let cells = "";
        let hitDays = 0;
        let okDays = 0;
        for (let i = 0; i < 7; i++) {
          const dt = new Date(w0);
          dt.setDate(w0.getDate() + i);
          const key = this._calKey(dt);
          const raw = days[key];
          if (raw) {
            hitDays += 1;
            if (this._habitPeriodAchieved(cfg, dayVal(dt))) okDays += 1;
          }
          cells += `<div class="north-caltab-habit-wcol">${dotCell(
            dt,
            raw,
            ["north-caltab-habit-wdot"],
            key,
            cfg
          )}<span class="north-caltab-habit-wdow">周${WD[dt.getDay()]}</span></div>`;
        }
        if (achievedNow(type)) doneCount += 1;
        return `<div class="north-caltab-habit-mcard north-caltab-habit-wcard" style="--tt-c:${escapeHtml(
          color
        )}">
                <div class="north-caltab-habit-mcard-head">${avatar(
                  color,
                  label
                )}<span class="north-caltab-habit-mcard-name">${escapeHtml(
          label
        )}</span><span class="north-caltab-habit-mcard-goal">${escapeHtml(
          habitGoalText(cfg)
        )}</span>${rangeBadge(cfg)}</div>
                <div class="north-caltab-habit-weekrow">${cells}</div>
                <div class="north-caltab-habit-mfoot"><span>${sicon(
                  "iconCheck"
                )}打卡 <b>${hitDays}</b> 天</span><span>${sicon(
          "iconCalendar"
        )}达标 <b>${okDays}</b> 天</span></div>
            </div>`;
      };

      /* —— 月视图：一个习惯一张卡（对齐参考 App 的月打卡卡） ——
         头 = 头像 + 名字，身 = 按真实日历排的 7 列打卡方格，
         脚 = 打卡天数 / 达标天数（达标按各自目标模型，坏习惯方向照算）。 */
      const mcardHtml = (type) => {
        const color = this._colorOf(type) || DEFAULT_TYPE_COLOR;
        const cfg = this._habitConfig(type);
        const label = cfg.alias || type;
        const { days } = this._habitYearData(type, year);
        const dayVal = (d) => this._habitDayValue(days, this._calKey(d), cfg);
        const y = anchor.getFullYear();
        const m = anchor.getMonth();
        const dim = new Date(y, m + 1, 0).getDate();
        const first = new Date(y, m, 1);
        const ws = this._calWeekStart();
        const lead =
          ws === 1
            ? first.getDay() === 0
              ? 6
              : first.getDay() - 1
            : first.getDay();
        let cells = "";
        for (let i = 0; i < lead; i++)
          cells += `<i class="north-caltab-habit-msq is-blank"></i>`;
        let hitDays = 0;
        let okDays = 0;
        for (let d = 1; d <= dim; d++) {
          const dt = new Date(y, m, d);
          const key = this._calKey(dt);
          const raw = days[key];
          if (raw) {
            hitDays += 1;
            if (this._habitPeriodAchieved(cfg, dayVal(dt))) okDays += 1;
          }
          cells += dotCell(dt, raw, ["north-caltab-habit-msq"], key, cfg);
        }
        const trail = (7 - ((lead + dim) % 7)) % 7;
        for (let i = 0; i < trail; i++)
          cells += `<i class="north-caltab-habit-msq is-blank"></i>`;
        if (achievedNow(type)) doneCount += 1;
        return `<div class="north-caltab-habit-mcard" style="--tt-c:${escapeHtml(
          color
        )}">
                <div class="north-caltab-habit-mcard-head">${avatar(
                  color,
                  label
                )}<span class="north-caltab-habit-mcard-name">${escapeHtml(
          label
        )}</span><span class="north-caltab-habit-mcard-goal">${escapeHtml(
          habitGoalText(cfg)
        )}</span>${rangeBadge(cfg)}</div>
                <div class="north-caltab-habit-mcal">${cells}</div>
                <div class="north-caltab-habit-mfoot"><span>${sicon(
                  "iconCheck"
                )}打卡 <b>${hitDays}</b> 天</span><span>${sicon(
          "iconCalendar"
        )}达标 <b>${okDays}</b> 天</span></div>
            </div>`;
      };

      /* —— 日视图：一个习惯一张卡（与周 / 月同一套卡片语言） ——
         特写「锚点那一天」：大号成绩 + 达标徽标 + 目标进度条 + 底部统计。
         徽标口径与旧版一致：日目标看当天，坏习惯不达标时显示「未达标」。 */
      const dayCardHtml = (type) => {
        const color = this._colorOf(type) || DEFAULT_TYPE_COLOR;
        const cfg = this._habitConfig(type);
        const label = cfg.alias || type;
        const { days } = this._habitYearData(type, year);
        const v = this._habitDayValue(days, this._calKey(anchor), cfg);
        const raw = days[this._calKey(anchor)];
        const ok = this._habitPeriodAchieved(cfg, v);
        const badge = ok ? "达标" : cfg.dir === "bad" ? "超标" : "未达标";
        const r1 = (n) => Math.round(n * 10) / 10;
        const valTxt =
          cfg.unit === "min" ? this._fmtStatsDur(v) : `${r1(v)} 次`;
        const goal = cfg.goal > 0 ? cfg.goal : 0;
        const pct =
          goal > 0 ? Math.min(100, Math.round((v / goal) * 100)) : v > 0 ? 100 : 0;
        if (achievedNow(type)) doneCount += 1;
        return `<div class="north-caltab-habit-mcard north-caltab-habit-dcard" style="--tt-c:${escapeHtml(
          color
        )}">
                <div class="north-caltab-habit-mcard-head">${avatar(
                  color,
                  label
                )}<span class="north-caltab-habit-mcard-name">${escapeHtml(
          label
        )}</span><span class="north-caltab-habit-mcard-goal">${escapeHtml(
          habitGoalText(cfg)
        )}</span>${rangeBadge(cfg)}</div>
                <div class="north-caltab-habit-dmain"><b class="north-caltab-habit-dval">${valTxt}</b><span class="north-caltab-habit-dbadge ${
                  ok ? "ok" : "no"
                }">${badge}</span></div>
                <div class="north-caltab-habit-dgoarrow"><div class="north-caltab-habit-dtrack"><i style="width:${pct}%"></i></div><span class="north-caltab-habit-dfrac">${r1(
                  v
                )}/${r1(goal)}</span></div>
                <div class="north-caltab-habit-mfoot"><span>${sicon(
                  "iconCheck"
                )}${raw ? raw.cnt : 0} ${this._calUnit()}</span><span>${sicon(
          "iconCalendar"
        )}共 <b>${this._fmtStatsDur(raw ? raw.min : 0)}</b></span></div>
            </div>`;
      };

      /* 周 / 月 / 日下习惯条目换皮，年 / 范围仍走 cardHtml；
         三种周期都是卡片网格，分组节内同样生效。
         形态只看**顶部段位**（这是「看哪种」的开关），所以整屏一定是一致的；
         各习惯自己的「查看窗口」只在范围模式下换掉那一段的日子。 */
      const itemsHtml = (list) => {
        if (period === "week")
          return `<div class="north-caltab-habit-mcards">${list
            .map(weekCardHtml)
            .join("")}</div>`;
        if (period === "month")
          return `<div class="north-caltab-habit-mcards">${list
            .map(mcardHtml)
            .join("")}</div>`;
        if (period === "day")
          return `<div class="north-caltab-habit-mcards">${list
            .map(dayCardHtml)
            .join("")}</div>`;
        return list.map((t) => cardHtml(t, viewOf(t))).join("");
      };

      /* 分组分节：**至少有一个习惯真正进了分组**才启用分节展示 ——
         只建了组但一个成员都没点进去时（组是空壳），习惯页保持原来的平铺。
         启用后各组按设置顺序各占一节；**没归组的习惯不装进任何「未分组」面板**，
         就按原来的样子平铺，排在各分组后面 —— 没分组 = 正常展示。
         顶部总览仍然统计全部习惯。 */
      const groupNames = this._habitGroupList();
      let bodyHtml;
      const grouped = [];
      let groupedCount = 0;
      groupNames.forEach((gname) => {
        const members = types.filter((t) => this._habitGroupOf(t) === gname);
        if (!members.length) return;
        grouped.push({ name: gname, members });
        groupedCount += members.length;
      });
      /* 组合本周进度：周期 = 当前周（与「每周 N 天」目标同一套口径，_calTabWeekStartDate）。
         单个习惯：应完成 = 本周已过天数 × 目标/7（折算，和月度分母同一算法），
         完成天数只数到今天；组合完成率 = 各习惯已完成 ÷ 应完成 求和。
         只在「今年」显示 —— 翻到别的年份时「本周剩余」没有意义。 */
      const isThisYear = year === now.getFullYear();
      /* 收起 / 展开共用的小箭头（内联 path，不依赖思源图标清单） */
      const chevSvg =
        '<svg class="north-caltab-habit-chev" viewBox="0 0 24 24" width="12" height="12"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      /* 「剩余 N 天」角标：跟着**顶部段位**走，看的是当前这段日子还剩几天没过 ——
         月视图数本月（月末天数 - 今天几号）、周视图数本周（7 - 已过天数，与
         「每周 N 天」目标同一套口径）、范围模式数窗口里今天之后还剩几天；
         日 / 年视图没有「补进度」的概念，不显示角标。
         文案带上段位前缀（本周剩余 / 本月剩余），一眼看出数的是哪一段；
         范围模式不加前缀（窗口就摆在旁边的日期字段里）。
         数出来的都是「还没过」的天数（今天不算），期中最后一天显示「最后 1 天」；
         范围已经结束（今天在窗口之后）时同样不显示。 */
      const leftPrefix =
        period === "week" ? "本周" : period === "month" ? "本月" : "";
      const leftLabel = (left) =>
        left == null || left < 0
          ? ""
          : left > 0
            ? `${leftPrefix}剩余 ${left} 天`
            : `${leftPrefix}最后 1 天`;
      const periodLeft = (() => {
        const t0 = new Date();
        t0.setHours(0, 0, 0, 0);
        if (period === "month") {
          const dim = new Date(t0.getFullYear(), t0.getMonth() + 1, 0).getDate();
          return dim - t0.getDate();
        }
        if (period === "week") {
          const ws = this._calTabWeekStartDate(t0);
          const elapsed = Math.min(
            7,
            Math.max(1, Math.round((t0 - ws) / 86400000) + 1)
          );
          return 7 - elapsed;
        }
        if (period === "range") {
          const win = rangeWin || this._habitRangeWindow();
          return Math.round((win.end - t0) / 86400000);
        }
        return null;
      })();

      /* 每个习惯「自己那个周期」的当前进度：
         日目标 → 本周达标天数 / 本周已过天数；周目标 → 本周累计 / 目标；
         月目标 → 本月累计 / 目标。分组汇总按各习惯自己的周期算，
         所以汇总条标题是「本期」而不是「本周」。 */
      const progOf = (type) => {
        const cfg = this._habitConfig(type);
        const { days } = this._habitYearData(type, year);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const ws = this._calTabWeekStartDate(today);
        const wElapsed = Math.min(
          7,
          Math.max(1, Math.round((today - ws) / 86400000) + 1)
        );
        if (cfg.period === "day") {
          let done = 0;
          for (let i = 0; i < wElapsed; i++) {
            const d = new Date(ws);
            d.setDate(ws.getDate() + i);
            if (
              this._habitPeriodAchieved(
                cfg,
                this._habitDayValue(days, this._calKey(d), cfg)
              )
            )
              done += 1;
          }
          return {
            done,
            goal: wElapsed,
            pct: Math.min(100, Math.round((done / wElapsed) * 100)),
            suffix: " 天",
          };
        }
        const cum =
          cfg.period === "week"
            ? this._habitPeriodSum(days, cfg, ws, 7)
            : this._habitPeriodSum(
                days,
                cfg,
                new Date(today.getFullYear(), today.getMonth(), 1),
                today.getDate()
              );
        return {
          done: cum,
          goal: cfg.goal,
          pct: Math.min(100, Math.round((cum / (cfg.goal || 1)) * 100)),
          suffix: cfg.goalUnit === "days" ? " 天" : "",
        };
      };
      const fmtP = (n) => Math.round(n * 10) / 10;

      /* 组合统计：完成率 = 各习惯自己周期进度的平均值；卡与展开节共用。
         「剩余天数」角标用 periodLeft（跟着顶部段位走），不跟单个习惯的周期。 */
      const gstats = (members) => {
        let s = 0;
        members.forEach((t) => {
          s += progOf(t).pct;
        });
        return {
          rate: members.length ? Math.round(s / members.length) : 0,
          left: periodLeft,
        };
      };

      /* 迷你进度行：名称 / 类型色进度条 / 百分比 / 本期进度÷目标 */
      const miniRow = (t) => {
        const w = progOf(t);
        const color = this._colorOf(t) || DEFAULT_TYPE_COLOR;
        return `<div class="north-caltab-habit-gsum-item" style="--tt-c:${escapeHtml(color)}">
                    <span class="north-caltab-habit-gsum-name">${escapeHtml(
                      this._habitConfig(t).alias || t
                    )}</span>
                    <div class="north-caltab-habit-gsum-track"><i style="width:${w.pct}%"></i></div>
                    <span class="north-caltab-habit-gsum-pct">${w.pct}%</span>
                    <span class="north-caltab-habit-gsum-frac">${fmtP(w.done)}/${fmtP(
          w.goal
        )}${w.suffix}</span>
                </div>`;
      };

      /* 展开态：节头下那条汇总 */
      const gsumHtml = (members) => {
        const s = gstats(members);
        return `<div class="north-caltab-habit-gsum">
                <div class="north-caltab-habit-gsum-row">
                    <span class="north-caltab-habit-gsum-label">本期</span>
                    <b class="north-caltab-habit-gsum-rate">${s.rate}%</b>
                    <div class="north-caltab-habit-gsum-track is-main"><i style="width:${s.rate}%"></i></div>
                    ${leftLabel(s.left) ? `<span class="north-caltab-habit-gsum-left">${leftLabel(s.left)}</span>` : ""}
                </div>
                <div class="north-caltab-habit-gsum-items">${members
                  .map(miniRow)
                  .join("")}</div>
            </div>`;
      };

      /* 收起态紧凑卡：整卡点击展开（data-habitgrp-toggle），
         卡上 = 组名 + 鼓励语 + 完成率 + 剩余天数 + 每个习惯的迷你进度 */
      const gcardHtml = (g) => {
        const s = gstats(g.members);
        const desc = this._habitGroupDesc(g.name);
        return `<div class="north-caltab-habit-gcard" data-habitgrp-toggle="${escapeHtml(
          g.name
        )}">
                <div class="north-caltab-habit-gcard-head">
                    <b class="north-caltab-habit-gcard-rate">${s.rate}%</b>
                    ${leftLabel(s.left) ? `<span class="north-caltab-habit-gsum-left">${leftLabel(s.left)}</span>` : ""}
                    ${chevSvg}
                </div>
                <div class="north-caltab-habit-gcard-name">${escapeHtml(g.name)}</div>
                ${
                  desc
                    ? `<div class="north-caltab-habit-gcard-desc">${escapeHtml(desc)}</div>`
                    : ""
                }
                <div class="north-caltab-habit-gsum-items">${g.members
                  .map(miniRow)
                  .join("")}</div>
            </div>`;
      };

      /* 展开态节：节头可点回收起（同一个 data-habitgrp-toggle） */
      const secHtml = (g) =>
        `<div class="north-caltab-habit-sec">
                <div class="north-caltab-habit-sec-head" data-habitgrp-toggle="${escapeHtml(
                  g.name
                )}"><span class="north-caltab-habit-sec-name">${escapeHtml(
          g.name
        )}</span><span class="north-caltab-habit-sec-count">${g.members.length} 个习惯</span>${
          this._habitGroupDesc(g.name)
            ? `<span class="north-caltab-habit-sec-desc">${escapeHtml(
                this._habitGroupDesc(g.name)
              )}</span>`
            : ""
        }<span class="north-caltab-habit-sec-chev">${chevSvg}</span></div>
                ${isThisYear ? gsumHtml(g.members) : ""}
                ${itemsHtml(g.members)}
            </div>`;

      if (!groupedCount) {
        bodyHtml = itemsHtml(types);
      } else {
        /* 收起的组排成自适应卡片网格（宽屏三列、窄屏自动降列），
           展开的组按原样整节展示，各自保持设置里的组顺序 */
        const cards = [];
        const secs = [];
        grouped.forEach((g) => {
          /* 历史年份一律走展开态 —— 那年没有「本周」，卡片上的进度没有意义 */
          if (isThisYear && !this._habitGroupOpen(g.name))
            cards.push(gcardHtml(g));
          else secs.push(secHtml(g));
        });
        /* 没归组的习惯：正常卡片直接垫在分组后面，不套节 */
        const rest = types.filter(
          (t) => !grouped.some((g) => g.members.indexOf(t) >= 0)
        );
        bodyHtml =
          (cards.length
            ? `<div class="north-caltab-habit-gcards">${cards.join("")}</div>`
            : "") +
          secs.join("") +
          (rest.length ? itemsHtml(rest) : "");
      }

      /* 顶部那行：只要有一个习惯不是日目标，说「今日完成」就不诚实了 ——
         这时改成「本期达成」（日目标看今天、周目标看本周、月目标看本月）。 */
      const allDaily = types.every((t) => this._habitConfig(t).period === "day");
      const pct = Math.round((doneCount / types.length) * 100);
      return `<div class="north-caltab-habit">
            ${toolbarHtml}
            <div class="north-caltab-habit-sum">
                <span class="north-caltab-habit-sum-text">${
                  allDaily ? "今日完成" : "本期达成"
                } <b>${doneCount}</b> / ${types.length}</span>
                <div class="north-caltab-habit-sum-track"><i style="width:${pct}%"></i></div>
            </div>
            ${bodyHtml}
        </div>`;
    }

    /* 时间轴视图结构（周 / 三日共用一段代码）：表头（星期 + 日期，今天沿用月视图
       那枚圆角方块徽标）+ 正文（左时间刻度 + N 天列）。
       列数由 --tt-wv-cols 传给样式表，所以「7 列」和「3 列」不需要各写一份 ——
       两个视图的事件排版、小时刻度、今天徽标全都只有一份实现，不会慢慢走样。
       表头不放在滚动容器里，所以滚动时它固定不动；
       刻度列宽度由 --tt-wv-gutter 统一控制、表头与正文共用，竖线才对得上。 */
    _buildCalendarTimelineHtml(days, byDate, todayKey) {
      /* 星期文字按日期自己算：连续几天的星期本来就是顺序的，
         这样 7 天和 3 天不用各传一份名字进来（结果与 _calWeekNames 一致）。 */
      const WD = ["日", "一", "二", "三", "四", "五", "六"];
      const headCells = days
        .map((d) => {
          const isToday = this._calKey(d) === todayKey;
          return `<span class="north-caltab-wv-dayname${
            isToday ? " today" : ""
          }"><span class="north-caltab-wv-wd">周${WD[d.getDay()]}</span><span class="north-caltab-num">${d.getDate()}</span></span>`;
        })
        .join("");

      /* 先把各天的记录解析排序，再据此估「弹性小时高」——
         记录密集的小时自动撑高，刻度、小时线、事件块全用这一份几何，
         挤在一起的记录上下排开、也不会和刻度线错位。 */
      const parsedByDate = {};
      days.forEach((d) => {
        const key = this._calKey(d);
        parsedByDate[key] = this._parseCalTimelineRecords(byDate[key] || []);
      });
      const layout = this._calTimelineLayout(parsedByDate, days);
      /* 初始滚动（挂载后滚到早上 7 点）要用同一份几何换算像素 */
      this._calTabWvLayout = layout;

      /* 刻度只写 0 ~ 23 点的起点，不写 24:00 —— 那是容器底边，写了会贴着边被切。
         标签落在自己那条线下方 2px，读起来是「这一小时从几点开始」。 */
      let hours = "";
      for (let h = 0; h < 24; h++) {
        hours += `<span class="north-caltab-wv-hour" style="top:${
          layout.cum[h] + 2
        }px">${pad2(h)}:00</span>`;
      }

      /* 小时线单独一层横跨所有列（小时高可变后不再等距，平铺背景画不了）：
         0 点那条不画 —— 表头的 border-bottom 就是它；24:00 是容器底边也不画。 */
      let lines = "";
      for (let h = 1; h < 24; h++) {
        lines += `<i style="top:${layout.cum[h]}px"></i>`;
      }

      const cols = days
        .map((d) => {
          const dKey = this._calKey(d);
          const events = this._buildCalendarTimelineEvents(
            parsedByDate[dKey],
            layout
          ).join("");
          return `<div class="north-caltab-wv-col" data-date="${dKey}">${events}</div>`;
        })
        .join("");

      /* --tt-wv-total / --tt-wv-cols 从这里写进 CSS：整天高度与列数都只有 JS 这一个来源，
         样式表里的列高、刻度列高、网格列数都读它们，不会两边写岔。 */
      return `<div class="north-caltab-weekview" style="--tt-wv-total:${layout.total}px;--tt-wv-cols:${days.length}">
                <div class="north-caltab-wv-head">
                    <span class="north-caltab-wv-headgap"></span>
                    ${headCells}
                </div>
                <div class="north-caltab-wv-body" id="northCaltabWeekBody">
                    <div class="north-caltab-wv-lines">${lines}</div>
                    <div class="north-caltab-wv-gutter">${hours}</div>
                    ${cols}
                </div>
            </div>`;
    }

    /* 渲染 Dock 日历区：默认折叠，即原本的本周周历条。
       animate 为 true 时（用户点展开或收起）做一次高度过渡。 */
    _renderLifeLogDockCalendar(root, animate) {
      const strip = root.querySelector("#lifelog-dock-week-strip");
      if (!strip) return;
      const expanded = !!this._lifelogDockCalExpanded;
      const html = expanded ? this._buildLifeLogDockMonthHtml() : this._buildLifeLogDockWeekHtml();
      const reduce =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      /* 元素不可见（高度为 0）时量不出高度，直接切换更稳 */
      if (!animate || reduce || !strip.offsetHeight) {
        this._stopCalAnim(strip);
        strip.classList.toggle("is-expanded", expanded);
        strip.innerHTML = html;
        return;
      }

      const from = strip.offsetHeight;
      const to = this._measureCalHeight(strip, html, expanded);
      const token = (this._lifelogDockCalAnimToken = (this._lifelogDockCalAnimToken || 0) + 1);

      strip.classList.toggle("is-expanded", expanded);
      strip.classList.add("is-animating");
      strip.style.maxHeight = from + "px";
      /* 展开时立刻换成月历，做出自上而下展开的效果；
         收起时先保留月历，等动画结束再换，否则会看到内容提前跳成周历条 */
      if (expanded) strip.innerHTML = html;
      void strip.offsetHeight;
      strip.style.maxHeight = to + "px";

      const finish = () => {
        /* 被新一次切换顶掉时不要再收尾，否则会把新一轮的内联高度清掉 */
        if (this._lifelogDockCalAnimToken !== token) return;
        if (!expanded) strip.innerHTML = html;
        this._stopCalAnim(strip);
      };
      if (strip._calAnimEnd) strip.removeEventListener("transitionend", strip._calAnimEnd);
      const onEnd = (e) => {
        if (e.target === strip && e.propertyName === "max-height") finish();
      };
      strip._calAnimEnd = onEnd;
      strip.addEventListener("transitionend", onEnd);
      /* 兜底：起止高度相同或过渡被跳过时不会触发 transitionend */
      setTimeout(finish, 420);
    }

    /* 清理过渡期间挂在容器上的内联状态与监听 */
    _stopCalAnim(strip) {
      strip.classList.remove("is-animating");
      strip.style.maxHeight = "";
      if (strip._calAnimEnd) {
        strip.removeEventListener("transitionend", strip._calAnimEnd);
        strip._calAnimEnd = null;
      }
    }

    /* 离屏量一次目标内容的高度。
       用 max-height 做过场（与 box-sizing 无关，最稳），所以必须知道终点高度，
       否则只能给一个很大的上限值，缓动会被拉平、看起来不均匀。 */
    _measureCalHeight(strip, html, expanded) {
      const probe = document.createElement("div");
      probe.className = "north-lifelog-calendar-week-strip" + (expanded ? " is-expanded" : "");
      probe.style.cssText =
        "position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;overflow:hidden;";
      probe.style.width = strip.clientWidth + "px";
      probe.style.boxSizing = "border-box";
      probe.innerHTML = html;
      strip.parentNode.appendChild(probe);
      const h = probe.offsetHeight;
      probe.remove();
      if (!expanded) return h;
      /* 展开态外面还套着 62vh 的上限，终点不能超过它，否则收尾时会跳一下 */
      const cap = Math.round(window.innerHeight * 0.62);
      return Math.min(h, cap);
    }

    /* 折叠态：本周周历条 + 顶部一行「年月 + 第几周」与展开按钮 */
    _buildLifeLogDockWeekHtml() {
      const today = new Date();
      const todayKey = this._calKey(today);
      const ws = this._calWeekStart();
      const names = this._calWeekNames(ws);
      const first = new Date(today);
      first.setHours(0, 0, 0, 0);
      first.setDate(first.getDate() + (ws === 1 ? (today.getDay() === 0 ? -6 : 1 - today.getDay()) : -today.getDay()));
      const byDate = this._calRecordsByDate();
      let headerCells = "";
      let cells = "";
      for (let i = 0; i < 7; i++) {
        const d = new Date(first);
        d.setDate(first.getDate() + i);
        const dKey = this._calKey(d);
        const holiday = SOLAR_HOLIDAYS[d.getMonth() + 1 + "-" + d.getDate()] || "";
        const cls = ["north-lifelog-calendar-day-cell"];
        if (dKey === todayKey) cls.push("today");
        if (d.getDay() === 0 || d.getDay() === 6) cls.push("weekend");
        if (dKey === this._lifelogDockDateFilter) cls.push("selected");
        headerCells += `<div class="north-lifelog-calendar-weekday-header">${names[i]}</div>`;
        cells += `<div class="${cls.join(" ")}" data-date="${dKey}" data-cal-day data-tip="${this._calDayTitle(d, (byDate[dKey] || []).length, this._calUnit())}">
                <span class="north-lifelog-calendar-day-num">${d.getDate()}</span>
                ${holiday ? '<span class="north-lifelog-calendar-day-sub">' + holiday + "</span>" : ""}
            </div>`;
      }
      return `
            <div class="north-lifelog-cal-head">
                <span class="north-lifelog-cal-caption">
                    <span class="north-lifelog-cal-title">${today.getFullYear()}年${today.getMonth() + 1}月</span>
                    <span class="north-lifelog-cal-week">第${this._calWeekNumber(today)}周</span>
                </span>
                <span class="north-lifelog-cal-nav">
                    <button class="north-lifelog-cal-toggle" data-cal-act="expand" data-tip="展开月历">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><use xlink:href="#iconDown"></use></svg>
                    </button>
                </span>
            </div>
            <div class="north-lifelog-calendar-weekday-row">${headerCells}</div>
            <div class="north-lifelog-calendar-day-row">${cells}</div>
        `;
    }

    /* 展开态：整月月历（固定 6 行 42 格，含农历副文本与记录圆点） */
    _buildLifeLogDockMonthHtml() {
      const anchor = this._lifelogDockCalAnchor instanceof Date ? this._lifelogDockCalAnchor : new Date();
      const year = anchor.getFullYear();
      const month = anchor.getMonth();
      const todayKey = this._calKey(new Date());
      const ws = this._calWeekStart();
      const names = this._calWeekNames(ws);
      const first = new Date(year, month, 1);
      const back = ws === 1 ? (first.getDay() === 0 ? 6 : first.getDay() - 1) : first.getDay();
      const start = new Date(year, month, 1 - back);
      /* 记录按日期归组，用于在格子里点出当天的类型色圆点 */
      const byDate = this._calRecordsByDate();
      const headerCells = names
        .map((w) => `<div class="north-lifelog-calendar-weekday-header">${w}</div>`)
        .join("");
      let cells = "";
      for (let i = 0; i < 42; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const dKey = this._calKey(d);
        const sub = this._getLifelogCalendarSubtext(d);
        const cls = ["north-lifelog-cal-day"];
        if (d.getMonth() !== month) cls.push("other-month");
        if (d.getDay() === 0 || d.getDay() === 6) cls.push("weekend");
        if (dKey === todayKey) cls.push("today");
        if (dKey === this._lifelogDockDateFilter) cls.push("selected");
        let dots = "";
        const dayRecords = byDate[dKey] || [];
        dayRecords.slice(0, 3).forEach((r) => {
          const c = safeColor(this._dockTypeColor(r.type)) || "";
          dots += `<span class="north-lifelog-cal-dot"${c ? ' style="--tt-dot:' + c + '"' : ""}></span>`;
        });
        cells += `<div class="${cls.join(" ")}" data-date="${dKey}" data-cal-day data-tip="${this._calDayTitle(d, dayRecords.length)}">
                    <span class="north-lifelog-cal-num">${d.getDate()}</span>
                    <span class="north-lifelog-cal-sub${sub.festival ? " is-festival" : ""}">${sub.text}</span>
                    <span class="north-lifelog-cal-dots">${dots}</span>
                </div>`;
      }
      return `
            <div class="north-lifelog-cal-head">
                <span class="north-lifelog-cal-caption">
                    <span class="north-lifelog-cal-title">${year}年${month + 1}月</span>
                </span>
                <span class="north-lifelog-cal-nav">
                    <button class="north-lifelog-cal-navbtn" data-cal-act="prev" data-tip="上个月">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><use xlink:href="#iconLeft"></use></svg>
                    </button>
                    <button class="north-lifelog-cal-navbtn" data-cal-act="next" data-tip="下个月">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><use xlink:href="#iconRight"></use></svg>
                    </button>
                    <button class="north-lifelog-cal-toggle" data-cal-act="collapse" data-tip="收起月历">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><use xlink:href="#iconUp"></use></svg>
                    </button>
                </span>
            </div>
            <div class="north-lifelog-calendar-weekday-row">${headerCells}</div>
            <div class="north-lifelog-cal-grid">${cells}</div>
        `;
    }

    /* ============================================================
     * 日历标签页（思源主区域的一个 tab，不是 Dock 侧栏视图）
     * 由 _openCalendarTab() 打开，容器是 tab 的 element。
     * 宽度远大于侧栏，所以格子里直接铺当天的记录条目。
     * 数据来自设置里的「日历数据源」：LifeLog 记录（默认，读块属性）或
     * 思源里**创建的文档**（按 created 排）。两种数据都被归一化成同一套字段
     * （date / time / type / content），所以下面所有视图与弹窗都不用知道数据是哪来的
     * —— 唯一的入口是 _calSourceRecords()。
     * 工具栏（左年月 / 右「段位 + 翻页 + 今天」）所有视图共用，由 _calTabView 切换：
     *   月        —— 星期表头 + 固定 6 行网格，三个月堆叠起来连续滚动（见 _paintCalendarTab）；
     *   周/三/日  —— 左时间刻度 + 7 / 3 / 1 天列，记录按时间比例摆成块。
     *                三者共用 _buildCalendarTimelineHtml，列数由 --tt-wv-cols 交给 CSS，
     *                所以只有一份排版实现；差异全在 _calTimelineDays 的「几天 / 起点」。
     * 农历 / 节气 / 节日复用 Dock 那套现成方法。
     * ============================================================ */

    /* 打开（已打开则聚焦）日历标签页 */
    _openCalendarTab() {
      if (typeof openTab !== "function") {
        showMessage(`${NAME}：当前环境不支持打开标签页`);
        return;
      }
      openTab({
        app: this.app,
        custom: {
          id: this.name + CAL_TAB_TYPE,
          icon: "iconCalendar",
          title: `${NAME}日历`,
          data: {},
        },
      });
    }

    /* 按「创建时间」取本年创建的文档，归一化成与记录**同构**的数组
       （date / time / type / content / color），所以四个视图与当天弹窗全都不用改。

       几处刻意的写法：
       1. 只取 id / content / created / ial 四列。blocks.markdown 可能很大，
          原来那个 SELECT * 会把每篇正文都拖回来 —— 这是这条查询最大的开销。
          ial 是为了取文档图标（`icon="1f389"` 这种），不多拿一行正文。
       2. 年份边界在 JS 里算成字面量，不用 SQLite 的 now：一来 `now` 是 UTC，
          跟本地时间差 8 小时（晚上跑会算错年份边界）；二来字面量范围更利于走索引。
       3. created 是定长 `YYYYMMDDHHmmss`，切片比 new Date() 更稳 —— 不受时区影响。 */
    async _queryCalendarDocs() {
      const year = new Date().getFullYear();
      const from = `${year}0101000000`;
      const to = `${year + 1}0101000000`;
      const sql = `SELECT id, content, created, ial
                   FROM blocks
                   WHERE type = 'd'
                     AND created >= '${from}'
                     AND created < '${to}'
                   ORDER BY created DESC
                   LIMIT ${CAL_DOCS_LIMIT}`;
      let rows = [];
      try {
        const resp = await this._request("/api/query/sql", { stmt: sql });
        if (resp && resp.code === 0 && Array.isArray(resp.data)) rows = resp.data;
      } catch (e) {
        console.warn(`${NAME}：日历文档数据加载失败`, e);
      }
      const records = rows
        .map((r) => {
          const c = String(r.created || "");
          const date =
            c.length >= 8 ? `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}` : "";
          /* 文档也有创建时刻，直接当作它在时间轴上的位置，周 / 三日 / 日视图才摆得下 */
          const time = c.length >= 12 ? `${c.slice(8, 10)}:${c.slice(10, 12)}` : "";
          /* 文档图标在 ial 里：icon="1f389"（内置 emoji 的码位）
             或 icon="material/xx.svg"（data/emojis 下的图片） */
          const im = String(r.ial || "").match(/icon="([^"]+)"/);
          return {
            id: `cal_doc_${r.id}`,
            date,
            time,
            /* 给个类型名：悬停提示与色块都靠它，空着提示里会多出一个孤零零的冒号 */
            type: "文档",
            content: String(r.content || "").trim(),
            icon: im ? im[1] : "",
            color: "",
          };
        })
        .filter((r) => r.date);

      /* 图标颜色要读像素，是异步的。先把不重复的图标并起来算一遍 ——
         直接对每条记录跑一遍的话，几十篇同图标的文档会并发跑几十次同样的取色。 */
      const icons = Array.from(new Set(records.map((r) => r.icon).filter(Boolean)));
      await Promise.all(icons.map((ic) => this._iconColorOf(ic)));
      records.forEach((r) => {
        r.color = r.icon ? this._calIconColors.get(r.icon) || "" : "";
      });
      return records;
    }

    /* 日历条目的颜色：数据源自带的颜色（文档图标解析出来的）优先，
       没有就回落到原来那套「类型 → 颜色」。
       **日历标签页的三处引用都走这里**，Dock 那套仍直接用 _dockTypeColor。 */
    _calRecordColor(r) {
      return safeColor(r && r.color) || safeColor(this._dockTypeColor(r && r.type)) || "";
    }

    /* 内容里持久化的多行分隔符 <br>：展示时换成一个空格（单行更易读），
       存回去时换回 \n（让 textarea 真的显示成多行）。
       存储选 <br> 不是 \n 是因为 parseLine 的 `.+` 不跨换行 —— 存 \n 会被截断，
       改一次就只剩第一行；<br> 让整段在 LINE_RE 里仍是「一行」，
       round-trip 稳定。 */
    _brToSpace(s) {
      return String(s == null ? "" : s).replace(/<br\s*\/?>/gi, " ");
    }
    _nlToBr(s) {
      return String(s == null ? "" : s).replace(/\r?\n/g, "<br>");
    }
    _brToNl(s) {
      return String(s == null ? "" : s).replace(/<br\s*\/?>/gi, "\n");
    }

    /* 把图标值翻译成能直接显示的字符：emoji 码位 → 真实字符（让用户
       鼠标悬停就能看见解析到的是哪个图标，比看 DevTools 方便），
       自定义文件路径 → 文件名去扩展名。空图标返回空串。 */
    _iconHint(r) {
      const icon = r && r.icon;
      if (!icon) return "";
      if (/^[0-9a-f]{1,8}$/i.test(icon)) {
        try {
          return String.fromCodePoint(parseInt(icon, 16));
        } catch (e) {
          return "";
        }
      }
      return (icon.split("/").pop() || "").replace(/\.[^.]+$/, "");
    }

    /* 图标 → 颜色（带缓存）。取不到就返回空串，调用方自然会回落到类型色。 */
    async _iconColorOf(icon) {
      if (!icon) return "";
      if (this._calIconColors.has(icon)) return this._calIconColors.get(icon);
      let color = "";
      try {
        color = await this._sampleIconColor(icon);
      } catch (e) {
        console.warn(`${NAME}：解析文档图标颜色失败`, e);
      }
      this._calIconColors.set(icon, color);
      return color;
    }

    /* 把图标画到 canvas 上、读像素取代表色。
       这样拿到的颜色是「这个图标本身长什么样」（📕 偏红、🌿 偏绿），
       不是按码位随便分配一个色 —— 代价是每条颜色都要过一遍 canvas，所以有缓存。

       图标有两类，来源不同：
         内置图标 —— ial 里存的是 emoji 的 UTF-32 码位（如 1f389），按字符画上去就行；
         自定义图标 —— ial 里存的是 data/emojis 下的相对路径，同源加载图片再画。
       两类画完后取色逻辑一样。 */
    async _sampleIconColor(icon) {
      const SIZE = 32;
      const canvas = document.createElement("canvas");
      canvas.width = SIZE;
      canvas.height = SIZE;
      const ctx = canvas.getContext("2d");
      if (!ctx) return "";

      const pick = () => {
        /* 读像素理论上不会被跨域挡住（emoji 是画的字、图片走同源 /emojis），
           但一旦抛出来就会把整个方法带崩，所以两条分支统一在这里兜住 ——
           约定是这个方法只返回颜色串或空串，不往外抛。 */
        try {
          return this._dominantColor(ctx.getImageData(0, 0, SIZE, SIZE).data);
        } catch (e) {
          return "";
        }
      };

      if (/^[0-9a-f]{1,8}$/i.test(icon)) {
        /* 内置 emoji。**等「这个字符能用这个字体画」**才有意义。
           之前用的 `document.fonts.ready` 解决得太快 —— 页面没主动声明任何字体
           时它会立刻 resolve，Chromium 还没把彩色 emoji 位图准备好就开始画了，
           结果是退化的线稿，drawImage/getImageData 拿到的就是一片灰红色描边。
           改成 `document.fonts.load(font, text)` 才是「等这个字符真的能画」的标准做法。 */
        if (document.fonts && document.fonts.load) {
          const ch = String.fromCodePoint(parseInt(icon, 16));
          const families = [
            '"Apple Color Emoji"',
            '"Segoe UI Emoji"',
            '"Noto Color Emoji"',
          ];
          for (const f of families) {
            try {
              await document.fonts.load(`${SIZE - 6}px ${f}`, ch);
            } catch (e) {
              /* load() 不支持的字族会抛，跳过 */
            }
          }
          /* ready() 作为最后一道保险 —— 它会在所有已声明字体就绪时 resolve */
          if (document.fonts.ready) {
            try {
              await document.fonts.ready;
            } catch (e) {
              /* 取不到色会被下面兜住 */
            }
          }
        }
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        /* 字族按平台从大到小列一遍，思源桌面端必然命中其中之一 */
        ctx.font = `${SIZE - 6}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
        ctx.fillText(String.fromCodePoint(parseInt(icon, 16)), SIZE / 2, SIZE / 2 + 1);
        return pick();
      }

      /* 自定义图标：/emojis/<path> 与内核同源，画进 canvas 后取像素不会被标记为污染 */
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          try {
            ctx.drawImage(img, 0, 0, SIZE, SIZE);
            resolve(pick());
          } catch (e) {
            resolve("");
          }
        };
        img.onerror = () => resolve("");
        img.src = `/emojis/${icon}`;
      });
    }

    /* 从像素里挑一个代表色。
       **不再给灰色像素基础权重了** —— 旧版本用 `0.15 + sat` 给灰色保底 15% 的权重，
       后果是 emoji 的深色描边/抗锯齿边缘（近黑近红）大量参与平均，把结果
       硬拽成灰红色 —— 看上去所有图标的颜色都差不多。改成纯饱和度加权
       （灰色像素权重 = 0，直接被排除），让真正着色的核心像素说了算。

       同时把 alpha 门槛从 128 抬到 200 —— 抗锯齿边缘是接近透明的
       偏灰颜色，把它们都丢进加权会把整体拉灰。 */
    _dominantColor(data) {
      let r = 0;
      let g = 0;
      let b = 0;
      let w = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 200) continue;
        const cr = data[i];
        const cg = data[i + 1];
        const cb = data[i + 2];
        const max = Math.max(cr, cg, cb);
        const min = Math.min(cr, cg, cb);
        const sat = max === 0 ? 0 : (max - min) / max;
        if (sat < 0.08) continue;   // 近灰色的像素（被抗锯齿污染）直接跳过
        const weight = sat;
        r += cr * weight;
        g += cg * weight;
        b += cb * weight;
        w += weight;
      }
      if (!w) return "";
      return this._iconColorFromRgb(Math.round(r / w), Math.round(g / w), Math.round(b / w));
    }

    /* 采样出来的 RGB → 与类型色同一套规则的颜色串：
       转 HSL 后按主题钳制亮度（浅色主题压到 39 以内），保证在日历的浅底上也读得清。
       这里不额外提饱和度 —— 图标本身是灰的，就让它灰着，别硬编一个色出来。 */
    _iconColorFromRgb(r, g, b) {
      const hex = `#${[r, g, b]
        .map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0"))
        .join("")}`;
      const hsl = this._hexToHsl(hex);
      if (!hsl) return hex;
      const maxL = this._themeMode() === "dark" ? 60 : 39;
      if (hsl[2] > maxL) hsl[2] = maxL;
      return `hsl(${hsl[0]}, ${hsl[1]}%, ${hsl[2]}%)`;
    }

    /* 按当前数据源把日历要用的数据准备好。
       1 秒内重复渲染（init 与 render 可能连着触发）直接复用，不重复请求。 */
    async _ensureCalendarData() {
      const fresh = (t) => t && Date.now() - t <= 1000;
      if (this._calSource() === "docs") {
        if (this._calDocsCache && fresh(this._calDocsCacheTime)) return;
        this._calDocsCache = await this._queryCalendarDocs();
        this._calDocsCacheTime = Date.now();
        return;
      }
      if (this._lifelogDockCache && fresh(this._lifelogDockCacheTime)) return;
      try {
        this._lifelogDockCache = await this._queryLifeLogDockRecords();
        this._lifelogDockCacheTime = Date.now();
      } catch (e) {
        console.warn(`${NAME}：日历数据加载失败`, e);
      }
    }

    /* 渲染日历标签页内容；container 由思源注入（tab 的 element） */
    async _renderCalendarTab(container) {
      if (!container) return;
      container.classList.add("fn__flex-1", "north-timetrail-caltab");
      /* 「内容颜色」开关落在容器类上：有这一类才走类型色配色，没有就是正文色原样。
         用 toggle（不是 add）是为了关掉开关后能还原 —— 这里每次重绘都会跑一遍。 */
      container.classList.toggle("north-caltab--type-color", this._calTextColor());
      /* 复用 Dock 那套自绘气泡：条目上带 data-tip，悬停显示完整记录行。
         气泡是全局单例，两个容器分别绑定、互不干扰（容器上各自有守卫）。 */
      this._bindDockTooltip(container);
      await this._ensureCalendarData();
      if (!(this._calTabAnchor instanceof Date)) this._calTabAnchor = new Date();
      this._paintCalendarTab(container);
    }

    /* 设置里换了数据源之后，把已经打开的日历标签页重绘一遍。
       日历在主区域（不在 Dock 里），所以按容器类名直接从文档里找。 */
    _refreshCalendarTabs() {
      document.querySelectorAll(".north-timetrail-caltab").forEach((el) => {
        this._renderCalendarTab(el).catch((e) =>
          console.warn(`${NAME}：刷新日历标签页失败`, e)
        );
      });
    }

    /* 重绘日历标签页（初次进入 / 切视图 / 回到今天 / 翻页后调用，不重新拉数据）。
       月视图用连续滚动：一次渲染「上月 / 本月 / 下月」三块，垂直堆叠进一个
       **原生滚动容器** —— 滚轮只是滚容器，内容真正跟手，能停在半个月的位置。
       滚动停下后由 _settleCalendarScroll() 把锚点对齐到停住的那一月并重建；
       重建后仍是同一窗口、同一屏内容，视觉上无缝，所以能一直滚下去。
       周视图是一次成型的静态网格，没有这套滑动窗口。 */
    _paintCalendarTab(container) {
      if (!container) return;
      this._bindCalendarTab(container);

      const anchor =
        this._calTabAnchor instanceof Date ? this._calTabAnchor : new Date();
      const ws = this._calWeekStart();
      const names = this._calWeekNames(ws);
      const todayKey = this._calKey(new Date());
      const byDate = this._calTabRecordsByDate();
      const view = this._calTabView;
      /* 时间轴视图 = 周 / 三日 / 日，三者共用同一套结构与尺寸，只有列数不同 */
      const isTimeline = view === "week" || view === "three" || view === "day";
      /* 表格视图：当月记录按日分组排成一张表（列＝时间/类型/内容/时长） */
      const isTable = view === "table";
      /* 习惯视图：挑中的类型一个一张卡 + 一整年的格子（数据用全量记录） */
      const isHabit = view === "habit";
      const isStats = view === "stats";
      /* 指标视图：指标（从记录内容里抽出来的数值）一张卡一条线。
         它另有一排「查看范围」段位（近 30/90 天…），但顶栏那组**不隐藏**：
           翻页 / 今天 —— 平移指标窗口（锚点就是窗口右端，见 _metricWindow）；
           类型筛选   —— 只统计选中类型的记录。
         两者都在这一屏里真管用，藏起来反而像坏了。 */
      const isMetric = view === "metric";
      /* 统计视图的周期状态：首次进入给默认值（按年，标题即「N 年」），
         与 Dock 统计互不干扰 */
      if (isStats) {
        if (!this._calTabStatsPeriod) this._calTabStatsPeriod = "year";
        if (!(this._calTabStatsAnchor instanceof Date)) {
          this._calTabStatsAnchor = new Date();
        }
      }

      /* 段位高亮直接由状态生成，不用事后补 class —— 重绘后不会丢 */
      const seg = (key, text) =>
        `<button class="${
          view === key ? "active" : ""
        }" data-caltab-view="${key}">${text}</button>`;

      /* 月视图看的是「月视图停在的月份」，时间轴视图看的是焦点日 —— 两个状态分开存，
         所以月视图滚动不会把周 / 三日 / 日的定位带偏（反过来也一样）。 */
      const monthAnchor = this._calMonthAnchor();

      /* 标题：月视图给年月，时间轴视图给这一段的起止日期，统计视图给周期起止，
         表格视图给「年月 · N 条记录」（当月一共多少条，扫一眼就有数） */
      let title = `${monthAnchor.getFullYear()}年${monthAnchor.getMonth() + 1}月`;
      if (isStats) {
        title = this._computeLifeLogDockPeriod(
          this._calTabStatsPeriod,
          this._calTabStatsAnchor
        ).label;
      }
      /* 表格的身体先算：标题里的条数就是它数出来的，算两次容易两边不一致 */
      const table = isTable
        ? this._buildCalendarTableHtml(byDate, monthAnchor)
        : null;
      if (isTable) {
        title = `${monthAnchor.getFullYear()}年${
          monthAnchor.getMonth() + 1
        }月 · ${table.count} ${this._calUnit()}`;
      }
      /* 习惯视图的周期状态：日 / 周 / 月 / 年 / 范围（默认年，与旧版行为一致）。
         锚点独立于月 / 时间轴 / 统计那几个存，翻页翻的是当前周期；
         旧版只存年份（_calTabHabitYear），现在统一由锚点推年份。 */
      if (isHabit) {
        if (!this._calTabHabitPeriod) this._calTabHabitPeriod = "year";
        if (!(this._calTabHabitAnchor instanceof Date)) {
          this._calTabHabitAnchor = new Date();
        }
      }
      const habitYear = isHabit
        ? this._calTabHabitAnchor.getFullYear()
        : 0;
      if (isHabit) {
        const n = this._habitTypes().length;
        const suffix = n ? ` · ${n} 个习惯` : " · 习惯";
        const hp = this._calTabHabitPeriod || "year";
        const ha = this._calTabHabitAnchor;
        if (hp === "day") {
          title = `${ha.getFullYear()}年${ha.getMonth() + 1}月${ha.getDate()}日${suffix}`;
        } else if (hp === "week") {
          const w0 = this._calTabWeekStartDate(ha);
          const w1 = new Date(w0);
          w1.setDate(w0.getDate() + 6);
          title = `${w0.getMonth() + 1}月${w0.getDate()}日 ~ ${w1.getMonth() + 1}月${w1.getDate()}日${suffix}`;
        } else if (hp === "month") {
          title = `${ha.getFullYear()}年${ha.getMonth() + 1}月${suffix}`;
        } else if (hp === "range") {
          title = `${this._habitRangeWindow().label}${suffix}`;
        } else {
          title = `${ha.getFullYear()}年${suffix}`;
        }
      }

      /* 月视图才需要算三个月的格子（126 格，每格都要算农历 / 节气），
         时间轴视图下这活儿纯属白干，所以放进分支里 */
      let body = "";
      if (isStats) {
        body = this._buildCalendarStatsHtml();
      } else if (isMetric) {
        body = this._buildCalendarMetricHtml();
        /* 标题与习惯视图同一个写法：先给这一段日期，再给「N 个指标」
           （表格视图是「年月 · N 条记录」，同一套节奏）。 */
        const win = this._metricWindow(this._metricRecords());
        const n = this._metrics().length;
        title = `${this._metricRangeLabel(win.from, win.to)} · ${
          n ? `${n} 个指标` : "指标"
        }`;
      } else if (isTable) {
        body = table.html;
      } else if (isHabit) {
        body = this._buildCalendarHabitHtml(habitYear);
      } else if (isTimeline) {
        const days = this._calTimelineDays(anchor, view);
        title = this._calRangeTitle(days[0], days.length);
        body = this._buildCalendarTimelineHtml(days, byDate, todayKey);
      } else {
        const year = monthAnchor.getFullYear();
        const month = monthAnchor.getMonth();
        const months = [-1, 0, 1]
          .map((off) => {
            const m = new Date(year, month + off, 1);
            return `<div class="north-caltab-month" data-month-offset="${off}">${this._buildCalendarMonthHtml(
              m,
              byDate,
              todayKey,
              ws
            )}</div>`;
          })
          .join("");
        body = `<div class="north-caltab-week">${names
          .map((n) => `<span>${n}</span>`)
          .join("")}</div>
            <div class="north-caltab-scroll" id="northCaltabScroll">
                ${months}
            </div>`;
      }

      /* 翻页箭头的提示语要跟着视图走：周视图翻的是周，说「上个月」就串了 */
      const stepBack = this._calStepTip(view, "prev");
      const stepNext = this._calStepTip(view, "next");

      /* 类型筛选：候选取当前数据里出现过的类型，空筛选就是「全部类型」（默认）。
         面板的开关状态存在实例上，重绘后要恢复 —— 否则连着勾第二个就勾不上了。 */
      const typeFilterOn = this._calTabTypeFilter.size > 0;
      const typeMenuOpen = !!this._calTabTypeMenuOpen;
      const typeMenuHtml = [
        `<div class="north-caltab-typeopt${typeFilterOn ? "" : " on"}" data-cal-type="">` +
          `<span class="north-caltab-typedot north-caltab-typedot-all"></span><span>全部类型</span></div>`,
      ]
        .concat(
          this._calTabTypeOptions(isMetric ? this._metricRecords() : null).map(
            (o) =>
              `<div class="north-caltab-typeopt${
                this._calTabTypeFilter.has(o.name) ? " on" : ""
              }" data-cal-type="${escapeHtml(o.name)}">` +
              `<span class="north-caltab-typedot" style="background:${o.color}"></span>` +
              `<span>${escapeHtml(o.name)}</span></div>`
          )
        )
        .join("");

      /* 表格视图的工具行：搜索框 + 筛选按钮（面板）。只在这一段位渲染；
         搜索词 / 时间筛选 / 面板开合都存实例上，重绘后原样恢复。
         类型这组直接复用工具栏那份类型筛选（_calTabTypeFilter）——
         两处筛的是同一个东西，不该出现两套口径。 */
      let tableToolsHtml = "";
      if (isTable) {
        const q = this._calTabTableSearch || "";
        const timeF = this._calTabTableTimeFilter || "";
        const tableFilterOn = typeFilterOn || !!timeF || !!q.trim();
        const tableFilterOpen = !!this._calTabTableFilterOpen;
        const noun = this._calUnit().slice(1);
        const typeChips = this._calTabTypeOptions()
          .map(
            (o) =>
              `<button class="north-caltab-filterchip${
                this._calTabTypeFilter.has(o.name) ? " on" : ""
              }" data-caltab-tfilter="${escapeHtml(o.name)}">` +
              `<span class="north-caltab-typedot" style="background:${o.color}"></span>` +
              `${escapeHtml(o.name)}</button>`
          )
          .join("");
        const timeChips = [
          ["", "全部"],
          ["today", "今日"],
          ["week", "本周"],
          ["month", "本月"],
        ]
          .map(
            ([v, label]) =>
              `<button class="north-caltab-filterchip${
                timeF === v ? " on" : ""
              }" data-caltab-tftime="${v}">${label}</button>`
          )
          .join("");
        tableToolsHtml = `
            <div class="north-caltab-table-tools">
                <div class="north-caltab-search">
                    <svg class="north-caltab-search-icon" viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><use xlink:href="#iconSearch"></use></svg>
                    <input class="north-caltab-search-input" type="text" placeholder="搜索${escapeHtml(
                      noun
                    )}" value="${escapeHtml(q)}" data-caltab-search />
                    ${
                      q
                        ? `<button class="north-caltab-search-clear" data-caltab-search-clear data-tip="清空搜索"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="10" height="10"><path d="M6 6l12 12M18 6L6 18"></path></svg></button>`
                        : ""
                    }
                </div>
                <div class="north-caltab-table-filter">
                    <button class="north-caltab-filterbtn${
                      tableFilterOn || tableFilterOpen ? " active" : ""
                    }" data-caltab-tablefilter data-tip="筛选">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><use xlink:href="#iconAlignCenter"></use></svg>
                    </button>
                    <div class="north-caltab-filtermenu${
                      tableFilterOpen ? " open" : ""
                    }">
                        <div class="north-caltab-filterhead">
                            <span class="north-caltab-filterhead-title">筛选${escapeHtml(
                              noun
                            )}</span>
                            <button class="north-caltab-filterclear" data-caltab-filter-clear>清除</button>
                        </div>
                        <div class="north-caltab-filtergroup">
                            <span class="north-caltab-filterlabel">类型</span>
                            <div class="north-caltab-filterchips">${typeChips}</div>
                        </div>
                        <div class="north-caltab-filtergroup">
                            <span class="north-caltab-filterlabel">时间</span>
                            <div class="north-caltab-filterchips">${timeChips}</div>
                        </div>
                    </div>
                </div>
            </div>`;
      }

      container.innerHTML = `
            <div class="north-caltab-bar">
                <span class="north-caltab-title">${title}</span>
                <div class="north-caltab-segments">
                    ${seg("month", "月")}
                    ${seg("week", "周")}
                    ${seg("three", "三")}
                    ${seg("day", "日")}
                    ${seg("table", "表格")}
                    ${seg("habit", "习惯")}
                    ${seg("stats", "统计")}
                    ${seg("metric", "指标")}
                </div>
                <div class="north-caltab-types">
                    <button class="north-caltab-typebtn${
                      typeFilterOn || typeMenuOpen ? " active" : ""
                    }" data-caltab-act="types" data-tip="按类型筛选">${escapeHtml(
        this._calTabFilterLabel()
      )}</button>
                    <div class="north-caltab-typemenu${typeMenuOpen ? " open" : ""}">${typeMenuHtml}</div>
                </div>
                <div class="north-caltab-navgroup">
                    <button class="north-caltab-navbtn" data-caltab-act="prev" data-tip="${stepBack}">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><use xlink:href="#iconLeft"></use></svg>
                    </button>
                    <button class="north-caltab-today-btn" data-caltab-act="today">今天</button>
                    <button class="north-caltab-navbtn" data-caltab-act="next" data-tip="${stepNext}">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><use xlink:href="#iconRight"></use></svg>
                    </button>
                </div>
                <div class="north-caltab-tools">
                    <button class="north-caltab-tool" data-caltab-act="refresh" data-tip="刷新">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><use xlink:href="#iconRefresh"></use></svg>
                    </button>
                    <button class="north-caltab-tool" data-caltab-act="settings" data-tip="设置">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><use xlink:href="#iconSettings"></use></svg>
                    </button>
                </div>
            </div>
            ${tableToolsHtml}
            ${body}
            <div class="north-caltab-modal" id="northCaltabModal" style="display:none">
                <div class="north-caltab-modal-bg"></div>
                <div class="north-caltab-modal-card">
                    <div class="north-caltab-modal-head">
                        <span class="north-caltab-modal-title"></span>
                        <button class="north-caltab-modal-close" type="button">✕</button>
                    </div>
                    <div class="north-caltab-modal-list"></div>
                </div>
            </div>
            <div class="north-caltab-edit" id="northCaltabEdit" style="display:none">
                <div class="north-caltab-modal-bg"></div>
                <div class="north-caltab-modal-card">
                    <div class="north-caltab-modal-head">
                        <span class="north-caltab-modal-title">修改记录</span>
                        <button class="north-caltab-modal-close" type="button" data-cal-edit-close>✕</button>
                    </div>
                    <div class="north-caltab-edit-form">
                        <label class="north-caltab-edit-row"><span>时间</span><input class="north-caltab-edit-input" data-cal-edit="time" placeholder="08:30"></label>
                        <label class="north-caltab-edit-row"><span>类型</span><input class="north-caltab-edit-input" data-cal-edit="type" placeholder="工作"></label>
                        <label class="north-caltab-edit-row north-caltab-edit-row-textarea"><span>内容</span><textarea class="north-caltab-edit-input" data-cal-edit="content" rows="3" wrap="soft" placeholder="写周报"></textarea></label>
                    </div>
                    <div class="north-caltab-edit-actions">
                        <button class="north-caltab-edit-btn" type="button" data-cal-edit-close>取消</button>
                        <button class="north-caltab-edit-btn primary" type="button" data-cal-edit-save>保存</button>
                    </div>
                </div>
            </div>
        `;

      /* 指标段位：整屏已经插好，按每张卡的真实宽度逐张成图（原因见 _fitMetricCharts） */
      if (isMetric) this._fitMetricCharts(container);

      /* 时间轴视图：进来先滚到早上 7 点 —— 活动基本都在白天，从 00:00 起
         要往下滚很久才看得到东西。表头在滚动容器之外，不会跟着滚走。
         7 点的像素位置要过一遍弹性小时布局：前面有小时被撑高时，
         7 点不在 7*40px 处。 */
      if (isTimeline) {
        const wv = container.querySelector("#northCaltabWeekBody");
        if (wv) {
          wv.scrollTop = this._calTabWvLayout
            ? this._calTabWvLayout.yOf(WEEK_INITIAL_HOUR * 60)
            : WEEK_INITIAL_HOUR * WEEK_HOUR_H;
        }
        return;
      }

      /* 表格视图：搜索输入触发的重绘，要把焦点和光标还给输入框 ——
         否则打一个字就失焦，没法连续输入。标记只对该次重绘生效，
         点筛选 chips 之类的重绘不会来抢焦点。 */
      if (isTable && this._calTabSearchFocus) {
        this._calTabSearchFocus = false;
        const searchInput = container.querySelector("[data-caltab-search]");
        if (searchInput) {
          searchInput.focus();
          const len = (searchInput.value || "").length;
          try {
            searchInput.setSelectionRange(len, len);
          } catch (e) {}
        }
      }

      /* 月视图：初始停在中间那一屏（本月）—— 三块等高，所以下标 1 就是本月。
         滚动监听挂在滚动容器上：它每次重绘都是新节点，因此用节点自身做守卫。 */
      const scroll = container.querySelector("#northCaltabScroll");
      if (!scroll) return;
      this._alignCalendarToCurrentMonth(scroll);
      if (!scroll._caltabScrollBound) {
        scroll._caltabScrollBound = true;
        let timer = null;
        scroll.addEventListener("scroll", () => {
          /* 对齐时由我们自己改的 scrollTop 也会派发 scroll 事件 —— 忽略掉，
             否则会二次滑动，在两个月份之间来回跳 */
          if (this._caltabSettling) return;
          /* 滚动过程中什么都不做，保证跟手；停住后再跨月对齐 */
          clearTimeout(timer);
          timer = setTimeout(() => this._settleCalendarScroll(container), 160);
        });
      }
    }

    /* 把月视图的滚动位置对齐到中间那一屏（本月）—— 三块等高，所以下标 1 就是本月。
       首次渲染时标签页可能刚插进 DOM、甚至还在后台（display: none），容器高度是 0，
       这时候设 scrollTop 是不生效的，页面会停在第一屏（上月）——
       表现就是「标题写着本月、网格却是上月」，点一次「今天」才恢复。
       所以这里做三层：能对齐立刻对齐，不能则等一帧，再不行等容器真的有了高度
       （标签页从后台切到前台时 ResizeObserver 会响）。
       每次重绘拿到的都是新的滚动容器，标记自然重置，所以重绘后都会重新对齐一次。
       返回 true 表示已经对齐。 */
    _alignCalendarToCurrentMonth(scroll, retried) {
      if (!scroll || scroll._caltabAligned) return true;
      const h = scroll.clientHeight;
      if (h > 0) {
        scroll.scrollTop = h;
        scroll._caltabAligned = true;
        return true;
      }
      /* 还没布局完：等一帧再试一次（只重试一次，避免空转） */
      if (!retried && typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
          if (scroll.isConnected !== false) this._alignCalendarToCurrentMonth(scroll, true);
        });
      }
      /* 标签页在后台创建时等一帧也拿不到高度，等它可见（尺寸变化）再补 */
      if (typeof ResizeObserver === "function" && !scroll._caltabResizeBound) {
        scroll._caltabResizeBound = true;
        const ro = new ResizeObserver(() => {
          if (this._alignCalendarToCurrentMonth(scroll, true)) ro.disconnect();
        });
        ro.observe(scroll);
      }
      return false;
    }

    /* 渲染一个月的 42 格网格 */
    _buildCalendarMonthHtml(anchorDate, byDate, todayKey, ws) {
      const year = anchorDate.getFullYear();
      const month = anchorDate.getMonth();
      /* 首格：本月 1 号所在周的第一天，固定铺满 6 行 */
      const first = new Date(year, month, 1);
      const lead =
        ws === 1 ? (first.getDay() === 0 ? 6 : first.getDay() - 1) : first.getDay();
      const start = new Date(year, month, 1 - lead);

      let cells = "";
      for (let i = 0; i < 42; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const dKey = this._calKey(d);
        const sub = this._getLifelogCalendarSubtext(d);
        const dayRecords = byDate[dKey] || [];
        const cls = ["north-caltab-day"];
        if (d.getMonth() !== month) cls.push("other-month");
        if (d.getDay() === 0 || d.getDay() === 6) cls.push("weekend");
        if (dKey === todayKey) cls.push("today");

        /* 只留内容，颜色靠一条短色条 + 极淡底表达（对齐参考图的胶囊样式）。
           一格里最多铺 5 条；还有剩余时把 +N 挂在最后一条的右侧同一行，
           不让它单独占一行 —— 那等于白白吃掉一格的高度。点 +N 看全部。 */
        const MAX_ITEMS = 5;
        const shown = dayRecords.slice(0, MAX_ITEMS);
        const rest = dayRecords.length - shown.length;
        const items = shown
          .map((r, idx) => {
            const c = this._calRecordColor(r);
            /* 格子里只放内容，完整的一行「时间 类型：内容 (图标)」挂到 data-tip，
               悬停时用自绘气泡显示。 */
            const full = `${r.time || ""} ${r.type || ""}：${this._brToSpace(r.content)}${
              this._iconHint(r) ? ` (${this._iconHint(r)})` : ""
            }`.trim();
            const chip = `<div class="north-caltab-item"${
              c ? ` style="--tt-c:${c}"` : ""
            } data-cal-id="${escapeHtml(
              r.id || ""
            )}" data-tip="${escapeHtml(full)}">${escapeHtml(r.content || "")}</div>`;
            if (idx === shown.length - 1 && rest > 0) {
              return `<div class="north-caltab-lastrow">${chip}<span class="north-caltab-more" data-tip="查看当天全部 ${dayRecords.length} ${this._calUnit()}">+${rest}</span></div>`;
            }
            return chip;
          })
          .join("");

        cells += `<div class="${cls.join(" ")}" data-date="${dKey}" data-caltab-day>
                    <div class="north-caltab-head">
                        <span class="north-caltab-num">${d.getDate()}</span>
                        <span class="north-caltab-sub${sub.kind ? " kind-" + sub.kind : ""}">${escapeHtml(sub.text)}</span>
                    </div>
                    <div class="north-caltab-items">${items}</div>
                </div>`;
      }
      return `<div class="north-caltab-grid">${cells}</div>`;
    }

    /* 滚动停住后把月份窗口对齐到停留的那一月（纯滑动窗口，不做吸附）。

       两个要点，缺一个就会「月份之间来回跳」：
       1. 步长用**月块的实测高度**，不是容器的 clientHeight —— 两者理论相等，
          但 height:100% 在 flex 容器里的解析不够确定，差一点就永远对不齐、反复滑动。
       2. 改 scrollTop 会再次派发 scroll 事件，所以用 _caltabSettling 把自触发的
          滚动忽略掉，杜绝二次滑动，并在下一帧才解锁。

       注：一度加过「松手吸附到整行」，实机用下来不如纯自由滚动自然，已撤掉。
       停在中间那一月时**完全不动**，滚到哪儿就是哪儿。 */
    _settleCalendarScroll(container) {
      const scroll = container.querySelector("#northCaltabScroll");
      if (!scroll) return;
      const months = scroll.querySelectorAll(".north-caltab-month");
      if (months.length !== 3) {
        /* 结构不对（理论上不会）时退回整体重绘，保证功能可用 */
        this._paintCalendarTab(container);
        return;
      }
      const h = months[0].offsetHeight || scroll.clientHeight;
      if (h <= 0) return;
      const idx = Math.round(scroll.scrollTop / h);
      if (idx === 1) return; /* 还在中间那一月：什么都不做，保留用户的滚动位置 */

      const step = idx <= 0 ? -1 : 1;
      /* 只挪**月视图自己的**月份状态，绝不碰 _calTabAnchor（焦点日）——
         在月视图里滚动是「翻看」，不该把周 / 三日 / 日视图的定位一起带走。
         踩过：滚完月视图再点「周」，显示的不是本周，因为锚点被顺手改成了别的月份的 1 号。 */
      const base = this._calMonthAnchor();
      const nextAnchor = new Date(base.getFullYear(), base.getMonth() + step, 1);
      this._calTabMonth = nextAnchor;

      const ws = this._calWeekStart();
      const todayKey = this._calKey(new Date());
      const byDate = this._calTabRecordsByDate();
      const buildMonth = (off) => {
        const m = new Date(
          nextAnchor.getFullYear(),
          nextAnchor.getMonth() + off,
          1
        );
        const el = document.createElement("div");
        el.className = "north-caltab-month";
        el.dataset.monthOffset = String(off);
        el.innerHTML = this._buildCalendarMonthHtml(m, byDate, todayKey, ws);
        return el;
      };

      /* 记住停在这一月之内的偏移（可能不足一屏），对齐后原样保留，视觉才连续 */
      const offsetInMonth = scroll.scrollTop - idx * h;

      /* 新窗口仍然是 [锚点-1][锚点][锚点+1]，而 nextAnchor 已经挪过一个月，
         所以补进来的那一块相对 nextAnchor 只差一格 —— 这里曾经误写成 ±2，
         导致每滚一次窗口就整体错一个月（标题与内容对不上），务必保持 ±1。 */
      if (step > 0) {
        /* 往下翻：砍掉最上面的「上月」，末尾补新的「下月」 */
        months[0].remove();
        scroll.appendChild(buildMonth(1));
      } else {
        /* 往上翻：砍掉最下面的「下月」，最前面补新的「上月」 */
        months[2].remove();
        scroll.insertBefore(buildMonth(-1), scroll.firstChild);
      }

      this._caltabSettling = true;
      this._updateCalendarTitle(container, nextAnchor);
      /* 新窗口里原来那一月落在中间块：目标 = 一个月高 + 该月内偏移 */
      scroll.scrollTop = h + offsetInMonth;
      const unlock = () => {
        this._caltabSettling = false;
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(unlock);
      else setTimeout(unlock, 16);
    }

    /* 滑动窗口时只更新工具栏上的年月（其余 DOM 不动） */
    _updateCalendarTitle(container, anchor) {
      const el = container.querySelector(".north-caltab-title");
      if (el) el.textContent = `${anchor.getFullYear()}年${anchor.getMonth() + 1}月`;
    }

    /* 绑定日历标签页交互：段位切视图、翻页 / 回到今天、点条目跳转、点 +N 弹当天列表。
       监听挂在容器本身，重绘 innerHTML 后无需重新绑定。 */
    _bindCalendarTab(container) {
      if (!container || container._caltabBound) return;
      container._caltabBound = true;
      /* 表格视图的搜索框：输入即过滤。重绘整页后由 _paintCalendarTab
         把焦点还给输入框（见 _calTabSearchFocus），这里只做防抖。
         输入法组词（isComposing）期间绝不重绘 —— 重绘会换掉输入框，
         把正在打的拼音直接打断；等 compositionend 再统一过滤。 */
      if (!container._caltabSearchInputBound) {
        container._caltabSearchInputBound = true;
        const applySearch = (value) => {
          this._calTabTableSearch = value || "";
          this._calTabSearchFocus = true;
          clearTimeout(this._calTabSearchTimer);
          this._calTabSearchTimer = setTimeout(() => {
            if (container.isConnected) this._paintCalendarTab(container);
          }, 160);
        };
        container.addEventListener("input", (e) => {
          const inp =
            e.target.closest && e.target.closest("[data-caltab-search]");
          if (!inp) return;
          this._calTabTableSearch = inp.value || "";
          if (e.isComposing) return;
          applySearch(inp.value);
        });
        container.addEventListener("compositionend", (e) => {
          const inp =
            e.target.closest && e.target.closest("[data-caltab-search]");
          if (!inp) return;
          applySearch(inp.value);
        });
      }
      /* 点面板外收起表格筛选面板。挂文档级、只挂一份，卸载时摘掉。
         收起时按钮的高亮按「是否真的有筛选在生效」重算，而不是一律去掉。 */
      if (!this._calTabTableFilterDocClick) {
        this._calTabTableFilterDocClick = (e) => {
          if (!this._calTabTableFilterOpen) return;
          if (
            e.target &&
            e.target.closest &&
            e.target.closest(".north-caltab-table-filter")
          )
            return;
          this._calTabTableFilterOpen = false;
          document
            .querySelectorAll(".north-caltab-filtermenu.open")
            .forEach((m) => m.classList.remove("open"));
          const stillOn =
            this._calTabTypeFilter.size > 0 ||
            !!this._calTabTableTimeFilter ||
            !!(this._calTabTableSearch || "").trim();
          document.querySelectorAll(".north-caltab-filterbtn").forEach((b) => {
            b.classList.toggle("active", stillOn);
          });
        };
        document.addEventListener("click", this._calTabTableFilterDocClick);
      }
      /* 点面板外收起「范围」的自绘日历弹层。挂文档级、只挂一份，卸载时摘掉。 */
      if (!this._calTabRangeDocClick) {
        this._calTabRangeDocClick = (e) => {
          if (!this._calTabHabitRangePick) return;
          if (
            e.target &&
            e.target.closest &&
            e.target.closest(".north-caltab-habit-range")
          )
            return;
          this._calTabHabitRangePick = "";
          document
            .querySelectorAll(".north-caltab-habit-rcal.open")
            .forEach((m) => m.classList.remove("open"));
          document
            .querySelectorAll(".north-caltab-habit-rfield.open")
            .forEach((b) => b.classList.remove("open"));
        };
        document.addEventListener("click", this._calTabRangeDocClick);
      }
      /* 点面板外收起类型筛选面板。挂文档级、只挂一份，卸载时摘掉。
         有筛选时按钮保持高亮，所以收起时按筛选状态重算，而不是一律去掉。 */
      if (!this._calTabTypesDocClick) {
        this._calTabTypesDocClick = (e) => {
          if (!this._calTabTypeMenuOpen) return;
          if (e.target && e.target.closest && e.target.closest(".north-caltab-types")) return;
          this._calTabTypeMenuOpen = false;
          document
            .querySelectorAll(".north-caltab-typemenu.open")
            .forEach((m) => m.classList.remove("open"));
          document.querySelectorAll(".north-caltab-typebtn").forEach((b) => {
            b.classList.toggle("active", this._calTabTypeFilter.size > 0);
          });
        };
        document.addEventListener("click", this._calTabTypesDocClick);
      }

      container.addEventListener("click", (e) => {
        /* —— 类型筛选：放在最前面拦掉。面板里的项自带 data-cal-type（「全部类型」
           那一项是空串），别让它们落到后面按 data-caltab-act 处理的分支里去 —— */
        if (e.target.closest && e.target.closest(".north-caltab-typebtn")) {
          e.stopPropagation();
          this._calTabTypeMenuOpen = !this._calTabTypeMenuOpen;
          const menu = container.querySelector(".north-caltab-typemenu");
          const btn = container.querySelector(".north-caltab-typebtn");
          if (menu) menu.classList.toggle("open", this._calTabTypeMenuOpen);
          if (btn) {
            btn.classList.toggle(
              "active",
              this._calTabTypeMenuOpen || this._calTabTypeFilter.size > 0
            );
          }
          return;
        }
        const typeOpt = e.target.closest && e.target.closest("[data-cal-type]");
        if (typeOpt) {
          const name = typeOpt.dataset.calType || "";
          if (!name) {
            /* 「全部类型」就是清空筛选 */
            this._calTabTypeFilter.clear();
          } else if (this._calTabTypeFilter.has(name)) {
            this._calTabTypeFilter.delete(name);
          } else {
            this._calTabTypeFilter.add(name);
          }
          /* 面板保持打开，方便连着勾几个；重绘会把面板恢复成打开态 */
          this._calTabTypeMenuOpen = true;
          this._paintCalendarTab(container);
          return;
        }

        /* —— 表格视图工具行：筛选面板开合 / 面板里的 chips / 清除 / 清空搜索。
           类型 chips 写的是共用的 _calTabTypeFilter（与工具栏那份同步），
           时间 chips 是单选（再点一次选中的就回到「全部」）。 —— */
        if (
          e.target.closest &&
          e.target.closest(".north-caltab-filterbtn")
        ) {
          this._calTabTableFilterOpen = !this._calTabTableFilterOpen;
          this._paintCalendarTab(container);
          return;
        }
        const tChip = e.target.closest && e.target.closest("[data-caltab-tfilter]");
        if (tChip) {
          const name = tChip.dataset.caltabTfilter || "";
          if (this._calTabTypeFilter.has(name)) this._calTabTypeFilter.delete(name);
          else this._calTabTypeFilter.add(name);
          this._paintCalendarTab(container);
          return;
        }
        const tTime = e.target.closest && e.target.closest("[data-caltab-tftime]");
        if (tTime) {
          const v = tTime.dataset.caltabTftime || "";
          this._calTabTableTimeFilter = this._calTabTableTimeFilter === v ? "" : v;
          this._paintCalendarTab(container);
          return;
        }
        if (e.target.closest && e.target.closest("[data-caltab-filter-clear]")) {
          this._calTabTypeFilter.clear();
          this._calTabTableTimeFilter = "";
          this._calTabTableSearch = "";
          this._paintCalendarTab(container);
          return;
        }
        if (e.target.closest && e.target.closest("[data-caltab-search-clear]")) {
          this._calTabTableSearch = "";
          this._paintCalendarTab(container);
          return;
        }

        /* —— 习惯「范围」的自绘日历：开合字段 / 翻月 / 选日期。
           同一份日历两处共用：
           scope 为空 → 顶部那对全局日期（data.habitRange[start|end]）；
           scope = 习惯名 → 那张习惯卡自己的查看窗口。
           起止写反了也没关系，两边都会自动对调。 —— */
        const rangeBtn =
          e.target.closest && e.target.closest("[data-caltab-rangebtn]");
        if (rangeBtn) {
          const which = rangeBtn.dataset.caltabRangebtn || "start";
          const scope = rangeBtn.dataset.caltabRangescope || "";
          const same =
            this._calTabHabitRangePick === which &&
            (this._calTabHabitRangeScope || "") === scope;
          if (same) {
            this._calTabHabitRangePick = "";
            this._calTabHabitRangeScope = "";
          } else {
            this._calTabHabitRangePick = which;
            this._calTabHabitRangeScope = scope;
            /* 打开时让弹层先停在所选字段当前的那个月 */
            const win = scope
              ? this._habitViewRange(scope) || this._habitRangeWindow()
              : this._habitRangeWindow();
            const d = which === "start" ? win.start : win.end;
            this._calTabHabitRangeView = new Date(
              d.getFullYear(),
              d.getMonth(),
              1
            );
          }
          this._paintCalendarTab(container);
          return;
        }
        const rangeNav =
          e.target.closest && e.target.closest("[data-caltab-rangenav]");
        if (rangeNav) {
          const dir = rangeNav.dataset.caltabRangenav === "next" ? 1 : -1;
          const view =
            this._calTabHabitRangeView instanceof Date
              ? this._calTabHabitRangeView
              : new Date();
          this._calTabHabitRangeView = new Date(
            view.getFullYear(),
            view.getMonth() + dir,
            1
          );
          this._paintCalendarTab(container);
          return;
        }
        const rangePick =
          e.target.closest && e.target.closest("[data-caltab-rangepick]");
        if (rangePick) {
          const key = rangePick.dataset.caltabRangepick || "";
          if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
            const which = this._calTabHabitRangePick || "start";
            const scope = this._calTabHabitRangeScope || "";
            if (scope) {
              /* 写进这张习惯卡自己的窗口：另一头保持原样（还没有就用当前
                 生效的那一段补上），所以先点哪个字段都行 */
              const w =
                this._habitViewRange(scope) || this._habitRangeWindow();
              this._habitSetView(
                scope,
                "custom",
                which === "start" ? key : w.startKey,
                which === "end" ? key : w.endKey
              );
            } else {
              /* 全局范围落盘：重启思源后再次进范围还是这一段 */
              const next = Object.assign({}, this.data.habitRange || {});
              next[which] = key;
              this.data.habitRange = next;
              this._persist("保存习惯范围");
            }
          }
          this._calTabHabitRangePick = "";
          this._calTabHabitRangeScope = "";
          this._paintCalendarTab(container);
          return;
        }

        /* —— 修改记录弹窗：优先处理（它的遮罩/关闭也复用了 .north-caltab-modal-* 类，
           不先拦住会被下面的「关闭当天列表弹窗」误判）—— */
        if (e.target.closest && e.target.closest("#northCaltabEdit")) {
          if (e.target.closest("[data-cal-edit-save]")) {
            this._saveCalEdit(container);
            return;
          }
          if (
            e.target.closest("[data-cal-edit-close]") ||
            e.target.closest(".north-caltab-modal-bg")
          ) {
            this._closeCalEdit(container);
            return;
          }
          return; /* 点在输入框等其它地方：保持打开 */
        }
        /* 关闭弹窗：点遮罩背景或右上角 ✕ */
        if (
          e.target.closest &&
          (e.target.closest(".north-caltab-modal-bg") ||
            e.target.closest(".north-caltab-modal-close"))
        ) {
          const modal = container.querySelector("#northCaltabModal");
          if (modal) modal.style.display = "none";
          return;
        }
        /* 段位切换：月 / 周 / 三 / 日 —— 四个都接上视图了，切过去就重绘。
           这里保留「不在 CAL_TAB_VIEWS 里就只切高亮」这条兜底：以后再加段位
           时，忘了接视图也不会点出一个空白页。注意这类段位不能走重绘那条路 ——
           重绘会把高亮重置回当前视图，点了立刻弹回，看着像坏了。 */
        const seg = e.target.closest && e.target.closest("[data-caltab-view]");
        if (seg) {
          const want = seg.dataset.caltabView;
          if (CAL_TAB_VIEWS.indexOf(want) >= 0 && this._calTabView !== want) {
            this._calTabView = want;
            /* 切回月视图时丢掉它自己的翻看位置，让它回到焦点日所在的那一个月 ——
               否则会出现「日视图停在 8 月 5 日，切到月视图却停在 11 月」这种对不上的状态 */
            if (want === "month") this._calTabMonth = null;
            this._paintCalendarTab(container);
            return;
          }
          container.querySelectorAll("[data-caltab-view]").forEach((b) =>
            b.classList.toggle("active", b === seg)
          );
          return;
        }
        /* 指标段位：卡片上的尺度段位（日 / 周 / 月）。同一份记录换个粒度看，
           只重绘这一屏 —— 重绘后按 _calTabMetricScale 恢复高亮。 */
        const metricScale =
          e.target.closest && e.target.closest("[data-caltab-metric-scale]");
        if (metricScale) {
          const name = metricScale.dataset.caltabMetricName || "";
          const v = metricScale.dataset.caltabMetricScale || "";
          if (name && METRIC_SCALES.some((o) => o.value === v)) {
            if (!this._calTabMetricScale) this._calTabMetricScale = {};
            this._calTabMetricScale[name] = v;
            this._paintCalendarTab(container);
          }
          return;
        }
        /* 指标段位：查看范围（近 30 天 / 近 90 天 / 近一年 / 全部） */
        const metricScope =
          e.target.closest && e.target.closest("[data-caltab-metric-scope]");
        if (metricScope) {
          this._calTabMetricScope =
            metricScope.dataset.caltabMetricScope || METRIC_SCOPE_DEFAULT;
          this._paintCalendarTab(container);
          return;
        }
        /* 统计柱子：周 / 月跳到那天的日视图，年跳到那月的月视图 */
        const statBar = e.target.closest && e.target.closest("[data-caltab-statbar]");
        if (statBar) {
          const v = String(statBar.dataset.caltabStatbar || "");
          let m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
          if (m) {
            this._calTabAnchor = new Date(+m[1], +m[2] - 1, +m[3]);
            this._calTabView = "day";
            this._paintCalendarTab(container);
            return;
          }
          m = v.match(/^(\d{4})-(\d{2})$/);
          if (m) {
            this._calTabAnchor = new Date(+m[1], +m[2] - 1, 1);
            this._calTabMonth = null;
            this._calTabView = "month";
            this._paintCalendarTab(container);
          }
          return;
        }
        /* 习惯分组卡 / 节头：展开或收起该分组。状态落盘（habitGroupExpanded），
           下次回来保持；重绘整个标签页让卡片与节两种形态即时切换 */
        const grpToggle =
          e.target.closest && e.target.closest("[data-habitgrp-toggle]");
        if (grpToggle) {
          const name = grpToggle.dataset.habitgrpToggle;
          const openMap = Object.assign({}, this.data.habitGroupExpanded || {});
          if (openMap[name]) delete openMap[name];
          else openMap[name] = true;
          this.data.habitGroupExpanded = openMap;
          this._persist("保存习惯分组展开");
          this._paintCalendarTab(container);
          return;
        }
        /* 习惯卡上的「查看窗口」胶囊：就地展开 / 收起设置条。不做浮层，
           重绘后靠 _calTabHabitViewOpen 恢复。 */
        const habitViewBtn =
          e.target.closest && e.target.closest("[data-caltab-habitview]");
        if (habitViewBtn) {
          const t = habitViewBtn.dataset.caltabHabitview || "";
          this._calTabHabitViewOpen = this._calTabHabitViewOpen === t ? "" : t;
          this._calTabHabitRangePick = "";
          this._calTabHabitRangeScope = "";
          this._paintCalendarTab(container);
          return;
        }
        /* 查看窗口的快捷预设：「跟随顶部」= 清掉这个习惯的窗口（回到默认视角）；
           「自定义」= 以当前正在看的那一段为起点，再用两枚日期字段微调。 */
        const habitViewPre =
          e.target.closest && e.target.closest("[data-caltab-habitvpreset]");
        if (habitViewPre) {
          const t = habitViewPre.dataset.caltabHabitvtype || "";
          const p = habitViewPre.dataset.caltabHabitvpreset || "";
          if (t) {
            if (p === "custom") {
              const w = this._habitViewRange(t) || this._habitRangeWindow();
              this._habitSetView(t, "custom", w.startKey, w.endKey);
              this._calTabHabitViewOpen = t;
            } else {
              this._habitSetView(t, p);
              this._calTabHabitViewOpen = "";
            }
            /* 设窗口只落盘，**不动顶部段位、不动锚点** —— 日 / 周 / 月 / 年
               正看着的时候配个窗口，不该把整个屏幕拽去「范围」。
               什么时候生效面板上的提示写着（「顶部段位切到「范围」时生效」），
               胶囊标签也会立刻换成所选窗口，反馈看得见，不用抢段位的活。 */
          }
          this._calTabHabitRangePick = "";
          this._calTabHabitRangeScope = "";
          this._paintCalendarTab(container);
          return;
        }
        /* 习惯视图：周期段位切换（日 / 周 / 月 / 年 / 范围）。
           切换时锚点回到今天（月视图锚到 1 号，避免 setMonth 溢出到下个月）。
           范围的起止日期已落盘持久 —— 切走再切回范围，还是上次选的那一段。
           注意这是**默认视角**：单独配过查看窗口的习惯不跟着它动。 */
        const habitPerBtn =
          e.target.closest && e.target.closest("[data-caltab-habitper]");
        if (habitPerBtn) {
          const p = habitPerBtn.dataset.caltabHabitper;
          if (["day", "week", "month", "year", "range"].indexOf(p) >= 0) {
            this._calTabHabitPeriod = p;
            this._calTabHabitAnchor = new Date();
            if (p === "month") this._calTabHabitAnchor.setDate(1);
            this._paintCalendarTab(container);
          }
          return;
        }
        /* 习惯格子：跳到那一天的日视图（和统计柱子走同一条路，
           都是「点一个日期 → 去那一天看看」） */
        const habitCell =
          e.target.closest && e.target.closest("[data-caltab-habitday]");
        if (habitCell) {
          const hm = String(habitCell.dataset.caltabHabitday || "").match(
            /^(\d{4})-(\d{2})-(\d{2})$/
          );
          if (hm) {
            this._calTabAnchor = new Date(+hm[1], +hm[2] - 1, +hm[3]);
            this._calTabView = "day";
            this._paintCalendarTab(container);
          }
          return;
        }
        /* 时长统计：局部周期切换（锚点回到今天）与翻页，独立于整页周期 */
        const durPeriodBtn = e.target.closest && e.target.closest("[data-caltab-durperiod]");
        if (durPeriodBtn) {
          const p = durPeriodBtn.dataset.caltabDurperiod;
          if (["day", "week", "month", "year"].indexOf(p) >= 0) {
            this._calTabDurPeriod = p;
            this._calTabDurAnchor = new Date();
            this._paintCalendarTab(container);
          }
          return;
        }
        const durNavBtn = e.target.closest && e.target.closest("[data-caltab-durnav]");
        if (durNavBtn) {
          const dir = durNavBtn.dataset.caltabDurnav === "next" ? 1 : -1;
          const p = this._calTabDurPeriod || "month";
          const a = new Date(
            this._calTabDurAnchor instanceof Date ? this._calTabDurAnchor : new Date()
          );
          if (p === "day") a.setDate(a.getDate() + dir);
          else if (p === "month") a.setMonth(a.getMonth() + dir);
          else if (p === "year") a.setFullYear(a.getFullYear() + dir);
          else a.setDate(a.getDate() + 7 * dir);
          this._calTabDurAnchor = a;
          this._paintCalendarTab(container);
          return;
        }
        /* 类型分布：局部周期切换（锚点回到今天）与翻页 —— 与时长统计同款 */
        const typePeriodBtn = e.target.closest && e.target.closest("[data-caltab-typeperiod]");
        if (typePeriodBtn) {
          const p = typePeriodBtn.dataset.caltabTypeperiod;
          if (["day", "week", "month", "year"].indexOf(p) >= 0) {
            this._calTabTypePeriod = p;
            this._calTabTypeAnchor = new Date();
            this._paintCalendarTab(container);
          }
          return;
        }
        const typeNavBtn = e.target.closest && e.target.closest("[data-caltab-typenav]");
        if (typeNavBtn) {
          const dir = typeNavBtn.dataset.caltabTypenav === "next" ? 1 : -1;
          const p = this._calTabTypePeriod || "month";
          const a = new Date(
            this._calTabTypeAnchor instanceof Date ? this._calTabTypeAnchor : new Date()
          );
          if (p === "day") a.setDate(a.getDate() + dir);
          else if (p === "month") a.setMonth(a.getMonth() + dir);
          else if (p === "year") a.setFullYear(a.getFullYear() + dir);
          else a.setDate(a.getDate() + 7 * dir);
          this._calTabTypeAnchor = a;
          this._paintCalendarTab(container);
          return;
        }
        /* 翻页 / 回到今天 */
        const btn = e.target.closest && e.target.closest("[data-caltab-act]");
        if (btn) {
          const act = btn.dataset.caltabAct;
          if (act === "today") {
            /* 统计视图的「今天」：回到当前周期 */
            if (this._calTabView === "stats") {
              this._calTabStatsAnchor = new Date();
              this._paintCalendarTab(container);
              return;
            }
            /* 习惯视图的「今天」：锚点回到今天；范围模式清掉顶部那对全局日期
               （落盘恢复默认 —— 下次进范围也是默认的「本月 1 号 ~ 月末」）。
               单独配过「查看窗口」的习惯看的是自己那一段，不受影响，要改就在
               它卡上那枚胶囊里改。顺便收起设置条。 */
            if (this._calTabView === "habit") {
              this._calTabHabitAnchor = new Date();
              this._calTabHabitViewOpen = "";
              this._calTabHabitRangePick = "";
              this._calTabHabitRangeScope = "";
              if ((this._calTabHabitPeriod || "year") === "range") {
                this.data.habitRange = null;
                this._persist("重置习惯范围");
              }
              this._paintCalendarTab(container);
              return;
            }
            /* 指标视图的「今天」：窗口锚点清回今天（默认状态） */
            if (this._calTabView === "metric") {
              this._calTabMetricAnchor = null;
              this._paintCalendarTab(container);
              return;
            }
            this._calTabAnchor = new Date();
            /* 月视图看的是 _calTabMonth，所以要一并清掉它 —— 一清就跟焦点日走，
               两种视图下「今天」都回到当月 / 当周 / 当日 */
            this._calTabMonth = null;
            this._paintCalendarTab(container);
            return;
          }
          /* 刷新：清掉数据缓存强制重拉（数据源可能是「记录」也可能是「文档」），再重绘 */
          if (act === "refresh") {
            this._lifelogDockCache = null;
            this._calDocsCache = null;
            this._refreshCalendarTabs();
            return;
          }
          /* 设置：打开「设置」弹窗（左侧导航 + 右侧内容，与侧边栏那套设置同一份内容）。
             关窗时弹窗自己会重绘日历，类型 / 颜色的变动照常反映。 */
          if (act === "settings") {
            /* 按钮上写了 data-settings-group 的（如指标空态）直接落到那个分区 */
            this._openSettingsModal(btn.dataset.settingsGroup || "");
            return;
          }
          /* 习惯视图按当前周期翻：日 ±1 天、周 ±7 天、月 ±1 月、年 ±1 年；
             范围整段平移（窗口长度不变）。锚点自己存，不碰日历焦点日，
             也不碰统计的周期锚点。 */
          if (this._calTabView === "habit") {
            const p = this._calTabHabitPeriod || "year";
            const a = new Date(
              this._calTabHabitAnchor instanceof Date
                ? this._calTabHabitAnchor
                : new Date()
            );
            const dir = act === "next" ? 1 : -1;
            if (p === "day") a.setDate(a.getDate() + dir);
            else if (p === "week") a.setDate(a.getDate() + 7 * dir);
            else if (p === "month") a.setMonth(a.getMonth() + dir);
            else if (p === "year") a.setFullYear(a.getFullYear() + dir);
            else {
              /* 范围模式：整段窗口往前 / 往后挪一段（落盘）。
                 顺手把各习惯**自定义**的窗口也按各自的长度一起平移 ——
                 不然按一下「下一段」，只有用「默认」的习惯动了、配过窗口的
                 原地不动，看着就像坏了。预设（本月 / 近 N 天）锚定的是「今天」，
                 本来就不该跟着时间轴跑，所以不参与平移。 */
              const fk = (d) =>
                d.getFullYear() +
                "-" +
                String(d.getMonth() + 1).padStart(2, "0") +
                "-" +
                String(d.getDate()).padStart(2, "0");
              /* 整月窗口（几月 1 号到那月月末）按月翻，翻出来还是整月 ——
                 按月长平移的话 9/1~9/30 会翻成 10/1~10/30，看着不像「下一个月」。
                 其它窗口（自定义的任意区间）就按自己的天数整段平移。 */
              const shiftWin = (s, e) => {
                const lastDay = new Date(
                  e.getFullYear(),
                  e.getMonth() + 1,
                  0
                ).getDate();
                if (s.getDate() === 1 && e.getDate() === lastDay) {
                  return {
                    start: fk(new Date(s.getFullYear(), s.getMonth() + dir, 1)),
                    end: fk(new Date(s.getFullYear(), s.getMonth() + dir + 1, 0)),
                  };
                }
                const len = Math.round((e - s) / 86400000) + 1;
                return {
                  start: fk(new Date(s.getTime() + len * dir * 86400000)),
                  end: fk(new Date(e.getTime() + len * dir * 86400000)),
                };
              };
              const rw = this._habitRangeWindow();
              this.data.habitRange = shiftWin(rw.start, rw.end);
              const all = Object.assign({}, this.data.habitViews || {});
              let moved = false;
              Object.keys(all).forEach((t) => {
                const raw = all[t];
                if (!raw || raw.preset !== "custom") return;
                const w = this._habitViewRange(t);
                if (!w) return;
                all[t] = Object.assign({}, raw, shiftWin(w.start, w.end));
                moved = true;
              });
              if (moved) this.data.habitViews = all;
              this._persist("保存习惯范围");
            }
            this._calTabHabitAnchor = a;
            this._paintCalendarTab(container);
            return;
          }
          /* 统计视图的翻页：挪统计周期的锚点（不碰日历焦点日） */
          if (this._calTabView === "stats") {
            const a = new Date(
              this._calTabStatsAnchor instanceof Date ? this._calTabStatsAnchor : new Date()
            );
            const dir = act === "next" ? 1 : -1;
            const p = this._calTabStatsPeriod || "year";
            if (p === "week") a.setDate(a.getDate() + 7 * dir);
            else if (p === "year") a.setFullYear(a.getFullYear() + dir);
            else a.setMonth(a.getMonth() + dir);
            this._calTabStatsAnchor = a;
            this._paintCalendarTab(container);
            return;
          }
          /* 表格视图按月翻：它看的是「月视图停在的月份」（两者共用同一个锚点），
             所以月视图 → 表格切过去是连续的，翻页体感也和月视图一致。
             不能走下面那条「时间轴按天翻」的通用分支 —— 表格是按月成篇的。 */
          if (this._calTabView === "table") {
            const base = this._calMonthAnchor();
            this._calTabMonth = new Date(
              base.getFullYear(),
              base.getMonth() + (act === "next" ? 1 : -1),
              1
            );
            this._paintCalendarTab(container);
            return;
          }
          /* 指标视图：按当前「查看范围」的步长平移窗口（范围=全部时按 30 天挪）。
             锚点不越过今天 —— 到了今天就到尽头，再往后按不动（空数据的方向没什么可看），
             想回当下按「今天」。这样顶栏那组翻页在当前视图里是真管用的。 */
          if (this._calTabView === "metric") {
            const days = parseInt(this._calTabMetricScope, 10);
            const step = Number.isFinite(days) && days > 0 ? days : 30;
            const base = new Date(
              this._calTabMetricAnchor instanceof Date ? this._calTabMetricAnchor : new Date()
            );
            base.setDate(base.getDate() + (act === "next" ? step : -step));
            const limit = new Date();
            limit.setHours(23, 59, 59, 999);
            if (base.getTime() > limit.getTime()) base.setTime(limit.getTime());
            this._calTabMetricAnchor = base;
            this._paintCalendarTab(container);
            return;
          }
          /* 时间轴视图是一次成型的静态网格，没有滑动窗口可滚，直接挪锚点再重绘。
             步长分两种：周视图翻整周（= 窗口宽度 7，相邻周首尾相接）；三日 / 日视图
             按「天」翻一格 —— 三日视图早先是整窗翻 3 天，一按就跳过去三天，落点太跳，
             想看清楚中间发生了什么得来回找，所以改成一天一天走。
             锚点保留原来的「日」，所以翻页是一格一格地走，不会跑偏。 */
          if (this._calTabView !== "month") {
            const base =
              this._calTabAnchor instanceof Date ? this._calTabAnchor : new Date();
            const step =
              this._calTabView === "three"
                ? 1
                : this._calTimelineDays(base, this._calTabView).length;
            this._calTabAnchor = new Date(
              base.getFullYear(),
              base.getMonth(),
              base.getDate() + (act === "next" ? step : -step)
            );
            this._paintCalendarTab(container);
            return;
          }
          /* 月视图上 / 下月：平滑滚到相邻那一屏，滚停后的对齐回调会顺势挪月份 ——
             按钮和滚轮的体感因此完全一致 */
          const scroll = container.querySelector("#northCaltabScroll");
          if (scroll && scroll.clientHeight > 0) {
            scroll.scrollTo({
              top: scroll.clientHeight * (act === "next" ? 2 : 0),
              behavior: "smooth",
            });
          } else {
            const base = this._calMonthAnchor();
            this._calTabMonth = new Date(
              base.getFullYear(),
              base.getMonth() + (act === "next" ? 1 : -1),
              1
            );
            this._paintCalendarTab(container);
          }
          return;
        }
        /* 表格视图的日期带：整条带子（含左边小箭头）只干一件事 —— 展开 / 收起这一天。
           它不挂 data-cal-id，所以不会走到下面的跳转分支；键盘回车也走这里。 */
        const tableToggle = e.target.closest && e.target.closest("[data-caltab-table-toggle]");
        if (tableToggle) {
          const key = tableToggle.dataset.caltabTableToggle;
          if (key) {
            if (!(this._calTabTableCollapsed instanceof Set)) {
              this._calTabTableCollapsed = new Set();
            }
            if (this._calTabTableCollapsed.has(key)) {
              this._calTabTableCollapsed.delete(key);
            } else {
              this._calTabTableCollapsed.add(key);
            }
            this._paintCalendarTab(container);
          }
          return;
        }
        /* 点记录条目 / 时间轴事件块 / 弹窗里的条目 → 跳到它所在的文档并高亮该块。
           放在 +N 徽标之前：+N 自己不带 data-cal-id，两者不冲突，
           但先判它语义更清楚（点条目是跳转，点 +N 是展开当天列表）。 */
        const item = e.target.closest && e.target.closest("[data-cal-id]");
        if (item && item.dataset.calId) {
          /* 从弹窗里点出去的顺手把弹窗关掉，免得切回来还挡着 */
          if (item.closest(".north-caltab-modal")) {
            const modal = container.querySelector("#northCaltabModal");
            if (modal) modal.style.display = "none";
          }
          this._gotoCalItem(item.dataset.calId);
          return;
        }
        /* 只有点 +N 徽标才弹出当天全部记录。点格子本身不该有反应 —— 它只负责排版。 */
        const moreBtn = e.target.closest && e.target.closest(".north-caltab-more");
        if (!moreBtn) return;
        const day = moreBtn.closest("[data-caltab-day]");
        if (day && day.dataset.date) {
          this._openCalendarDayModal(container, day.dataset.date);
        }
      });
      /* 右键记录 → 弹出「修改记录」窗。
         文档（id 带 cal_doc_ 前缀）没有可改的内容，忽略，交给浏览器的默认右键菜单。 */
      container.addEventListener("contextmenu", (e) => {
        const item = e.target.closest && e.target.closest("[data-cal-id]");
        if (!item || !item.dataset.calId) return;
        const id = item.dataset.calId;
        if (id.indexOf("lifelog_dock_") !== 0) return;
        const rec = (this._lifelogDockCache || []).find((r) => r && r.id === id);
        if (!rec) return;
        e.preventDefault();
        this._openCalEditModal(container, rec);
      });
    }

    /* 右键打开「修改记录」弹窗，用这条记录当前的时间 / 类型 / 内容预填。
       多行内容在属性里存的是 `<br>`，进 textarea 要换回 \n 才看到多行。 */
    _openCalEditModal(container, rec) {
      const modal = container.querySelector("#northCaltabEdit");
      if (!modal) return;
      const set = (key, val) => {
        const el = container.querySelector(`[data-cal-edit="${key}"]`);
        if (el) el.value = val == null ? "" : val;
      };
      set("time", rec.time);
      set("type", rec.type);
      set("content", this._brToNl(rec.content));
      this._calEditId = rec.id || "";
      modal.style.display = "";
      const contentEl = container.querySelector('[data-cal-edit="content"]');
      if (contentEl) contentEl.focus();
    }

    _closeCalEdit(container) {
      const modal = container.querySelector("#northCaltabEdit");
      if (modal) modal.style.display = "none";
      this._calEditId = "";
    }

    /* 保存修改：先改段落文本、再改块属性 —— 两处必须一致，
       否则日历（读属性）和文档正文（读文本）会各说各话。 */
    async _saveCalEdit(container) {
      const id = this._calEditId;
      if (!id) return;
      const raw = String(id).replace(/^lifelog_dock_/, "");
      if (!this._validId(raw)) {
        showMessage(`${NAME}：找不到对应的块`);
        return;
      }
      const val = (key) =>
        (container.querySelector(`[data-cal-edit="${key}"]`) || {}).value || "";
      /* 内容里按下的 Enter 是 \n —— 持久化时换成 <br>，否则 parseLine 的 `.+`
         不会跨换行，第二次保存就只剩第一行了。_nlToBr 把它变成单行字符串，
         存进属性 / 写进 markdown 都是「一行」，round-trip 稳定。 */
      const content = this._nlToBr(val("content").trim());
      const rawMd = `${val("time").trim()} ${val("type").trim()}：${content}`.trim();
      /* 复用同一套解析规则：格式不对直接拦下，顺带把 8:30 规范成 08:30 */
      const info = parseLine(rawMd);
      if (!info) {
        showMessage(`${NAME}：格式不对，应为「时间 类型：内容」，例如 08:30 工作：写周报`);
        return;
      }
      const md = `${info.time} ${info.type}：${info.content}`;
      /* setBlockAttrs 是「整体替换」不是 merge —— 要保留的属性也必须显式带上，
         不然保存后这条记录就丢了 date / created，日历就找不到它了。
         跟插件里现成的 _tagBlock 走同一条路：先 getBlockAttrs 拿旧的，
         6 个 key 全写一遍（time/type/content/updated 用新的，date 跟 rec 一致，
         created 从旧里取，没有就兜底用 now）。 */
      const rec = (this._lifelogDockCache || []).find((r) => r && r.id === id);
      let existing = {};
      try {
        const resp = await this._request("/api/attr/getBlockAttrs", { id: raw });
        existing = (resp && resp.data && typeof resp.data === "object") ? resp.data : {};
      } catch (e) {
        /* getBlockAttrs 失败时走空对象；下面 created 兜底用 now */
      }
      const now = formatDateTime();
      const dateVal = (rec && rec.date) || existing[this._attr("date")] || "";
      const saveBtn = container.querySelector("[data-cal-edit-save]");
      if (saveBtn) saveBtn.disabled = true;
      try {
        await this._request("/api/block/updateBlock", {
          id: raw,
          dataType: "markdown",
          data: md,
        });
        await this._request("/api/attr/setBlockAttrs", {
          id: raw,
          attrs: {
            [this._attr("content")]: info.content,
            [this._attr("type")]: info.type,
            [this._attr("time")]: info.time,
            [this._attr("date")]: dateVal,
            [this._attr("created")]: existing[this._attr("created")] || now,
            [this._attr("updated")]: now,
          },
        });
        this._closeCalEdit(container);
        showMessage(`${NAME}：已修改`);
        /* 文本和属性都变了：缓存作废，再重绘日历与 Dock */
        this._lifelogDockCache = null;
        this._lifelogDockCacheTime = 0;
        this._refreshCalendarTabs();
        this._refreshLifeLogDockContent(true);
      } catch (e) {
        showMessage(`${NAME}：修改失败：${e.message}`);
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    }

    /* 打开某条数据对应的块（并高亮它）。
       记录的 id 带前缀，取真实块 ID 前先剥掉：
         lifelog 那套是 `lifelog_dock_<段落块ID>`，文档那套是 `cal_doc_<文档块ID>`。
       openTab 的 doc.id 文档块和普通块都收（官方 API 说明就是「文档或者块ID」）——
       传普通块 ID 会打开它所在的文档并把那块高亮出来，正是这里要的效果。 */
    _gotoCalItem(id) {
      const raw = String(id || "")
        .replace(/^lifelog_dock_/, "")
        .replace(/^cal_doc_/, "");
      if (!this._validId(raw)) {
        showMessage(`${NAME}：这条数据找不到对应的块`);
        return;
      }
      if (typeof openTab !== "function") {
        showMessage(`${NAME}：当前环境不支持打开标签页`);
        return;
      }
      openTab({ app: this.app, doc: { id: raw, action: ["cb-get-hl"] } });
    }

    /* 弹出某一天的全部记录（格子内只铺了前 4 条，这里给完整列表） */
    _openCalendarDayModal(container, dateKey) {
      const modal = container.querySelector("#northCaltabModal");
      if (!modal) return;
      const records = this._calTabRecordsByDate()[dateKey] || [];
      const parts = String(dateKey).split("-");
      const y = Number(parts[0]);
      const m = Number(parts[1]);
      const d = Number(parts[2]);
      const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
      const wd = week[new Date(y, m - 1, d).getDay()] || "";

      const titleEl = modal.querySelector(".north-caltab-modal-title");
      const listEl = modal.querySelector(".north-caltab-modal-list");
      const unit = this._calUnit();
      if (titleEl) {
        titleEl.textContent = `${y}年${m}月${d}日 ${wd} · ${records.length} ${unit}`;
      }
      if (listEl) {
        listEl.innerHTML = records.length
          ? records
              .map((r) => {
                const c = this._calRecordColor(r);
                return `<div class="north-caltab-modal-item"${
                  c ? ` style="--tt-c:${c}"` : ""
                } data-cal-id="${escapeHtml(r.id || "")}">${escapeHtml(
                  this._brToSpace(r.content)
                )}</div>`;
              })
              .join("")
          : `<div class="north-caltab-modal-empty">这一天还没有${unit.slice(1)}</div>`;
      }
      modal.style.display = "";
    }

    /* 绑定 Dock 日历区交互：展开与收起、切换月份、点击某天筛选。
       监听挂在容器上做事件委托，因此重渲染 innerHTML 后无需重新绑定。 */
    _bindLifeLogDockCalendar(root) {
      const strip = root.querySelector("#lifelog-dock-week-strip");
      if (!strip || strip._lifelogDockBound) return;
      strip._lifelogDockBound = true;
      strip.addEventListener("click", (e) => {
        const actBtn = e.target.closest("[data-cal-act]");
        if (actBtn) {
          const act = actBtn.dataset.calAct;
          /* 展开与收起做高度过渡；切换月份只是换内容，不需要动画 */
          let animate = false;
          if (act === "expand") {
            this._lifelogDockCalExpanded = true;
            this._lifelogDockCalAnchor = new Date();
            animate = true;
          } else if (act === "collapse") {
            this._lifelogDockCalExpanded = false;
            animate = true;
          } else {
            const base = this._lifelogDockCalAnchor instanceof Date ? this._lifelogDockCalAnchor : new Date();
            const step = act === "next" ? 1 : -1;
            this._lifelogDockCalAnchor = new Date(base.getFullYear(), base.getMonth() + step, 1);
          }
          this._renderLifeLogDockCalendar(root, animate);
          return;
        }
        const cell = e.target.closest(".north-lifelog-calendar-day-cell, .north-lifelog-cal-day");
        if (!cell) return;
        if (cell.classList.contains("selected")) {
          cell.classList.remove("selected");
          this._lifelogDockDateFilter = null;
        } else {
          strip
            .querySelectorAll(".north-lifelog-calendar-day-cell, .north-lifelog-cal-day")
            .forEach((c) => c.classList.remove("selected"));
          cell.classList.add("selected");
          this._lifelogDockDateFilter = cell.dataset.date;
        }
        const listEl = root.querySelector("#north-lifelog-dock-list");
        if (listEl && this._lifelogDockCache) {
          this._renderLifeLogDockList(listEl, this._lifelogDockCache);
        }
      });
    }

    /* ============================================================
     * Dock 悬浮提示（替代原生 title）
     * 原生 title 由浏览器绘制：样式与思源不搭、要等约 1 秒才出现、
     * 且无法跟随主题。这里改成事件委托 + 一个自绘气泡：
     *   - 元素只要带 data-tip 属性即可，日历重渲染 innerHTML 后无需重新绑定
     *   - 气泡挂到 body 上（fixed 定位）：日历在 Dock 顶部，若挂在 Dock 内，
     *     向上的气泡会被祖先容器的 overflow 裁掉
     * ============================================================ */
    _bindDockTooltip(root) {
      if (!root || root._lifelogTipBound) return;
      root._lifelogTipBound = true;
      /* 单例：Dock 重建时复用，避免留下孤儿节点 */
      let tip = document.querySelector(".north-lifelog-tip");
      if (!tip) {
        tip = document.createElement("div");
        tip.className = "north-lifelog-tip";
        document.body.appendChild(tip);
      }

      let timer = null;
      let owner = null; /* 当前持有气泡的元素，用于忽略格子内部的游走 */

      const hide = () => {
        clearTimeout(timer);
        timer = null;
        tip.classList.remove("is-visible");
      };
      const show = (target) => {
        const text = target.getAttribute("data-tip");
        const html = target.getAttribute("data-tip-html");
        if (!text && !html) return;
        clearTimeout(timer);
        /* 轻微延迟：快速划过一排日期格时不会连闪 */
        timer = setTimeout(() => {
          /* 富文本 tip（data-tip-html）走 innerHTML：两行打卡进度那种带标签药丸、
             数值加粗的排版；普通 tip 仍是纯文本单行。都是插件自己拼的串，无注入面。 */
          if (html) {
            tip.innerHTML = html;
            tip.classList.add("is-multiline");
          } else {
            tip.textContent = text;
            tip.classList.toggle("is-multiline", text.indexOf("\n") >= 0);
          }
          tip.classList.add("is-visible");
          this._placeTooltip(tip, target);
        }, 90);
      };

      /* data-tip（纯文本）与 data-tip-html（富文本）两种属性都能触发气泡 */
      root.addEventListener("mouseover", (e) => {
        const target =
          e.target.closest &&
          e.target.closest("[data-tip],[data-tip-html]");
        if (!target || !root.contains(target)) {
          if (owner) {
            owner = null;
            hide();
          }
          return;
        }
        if (target === owner) return; /* 同一格内部移动，保持不动 */
        owner = target;
        show(target);
      });
      root.addEventListener("mouseout", (e) => {
        const target =
          e.target.closest &&
          e.target.closest("[data-tip],[data-tip-html]");
        if (!target) return;
        const next = e.relatedTarget;
        /* 在同一个格子内部移动（div → span）不算离开 */
        if (next && target.contains(next)) return;
        if (target === owner) owner = null;
        hide();
      });
      /* 滚动或点击后目标可能移位，直接收起 */
      root.addEventListener("scroll", hide, true);
      root.addEventListener("click", hide, true);
      window.addEventListener("resize", hide);
    }

    /* 移除气泡节点（Dock 销毁时调用），避免下次加载残留旧节点 */
    _destroyDockTooltip() {
      const tip = document.querySelector(".north-lifelog-tip");
      if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
    }

    /* 把气泡摆到目标元素上方并水平居中（视口坐标，配合 fixed 定位）：
       顶部空间不够时翻到下方，水平方向夹在视口内，避免贴边被裁。 */
    _placeTooltip(tip, target) {
      const r = target.getBoundingClientRect();
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      let top = r.top - th - 8;
      if (top < 4) top = r.bottom + 8;
      let left = r.left + r.width / 2 - tw / 2;
      const maxLeft = window.innerWidth - tw - 8;
      left = Math.max(8, Math.min(left, maxLeft));
      tip.style.top = `${Math.round(top)}px`;
      tip.style.left = `${Math.round(left)}px`;
    }

    /* 按当前「时间计算模式」给每条记录算展示用的区间与「持续」。
       返回 perRecord：记录 id → { range, durText }；carries：日期 → 次日开头的跨天延续段。
       end（结束模式，默认）：节点时间为结束时间 —— 区间从同日上一条起到当前为止，
       持续 = 当前 − 上一条；当天最早的一条前面没有同日记录，只显示自己的时间。
       start（开始模式）：节点时间为开始时间 —— 区间从当前起到下一条开始，
       持续 = 下一条 − 当前；下一条在次日时按天拆成两段：当天算到 24:00、
       摆在当天最后一条上，00:00 起的余下一段挂到次日时间轴开头。
       时间解析不出 / 时长非正的记录一律不编区间，只显示原时间文本。 */
    _lifelogTimelineParts(records) {
      const perRecord = new Map();
      const carries = new Map();
      const toMin = (t) => {
        const m = String(t == null ? "" : t).match(/(\d{1,2}):(\d{2})/);
        if (!m) return null;
        const h = Number(m[1]);
        const mi = Number(m[2]);
        if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59)) return null;
        return h * 60 + mi;
      };
      const fmtDur = (min) => {
        const h = Math.floor(min / 60);
        const mm = min % 60;
        return h > 0 ? `${h}时${mm}分` : `${mm}分`;
      };
      const mode = this._timeCalcMode();
      /* 时间轴统一按时间正序排：日期升序、同日内分钟升序 */
      const list = (records || [])
        .map((r) => ({ rec: r, min: toMin(r && r.time) }))
        .filter((x) => x.rec && x.rec.date && x.min !== null)
        .sort((a, b) => a.rec.date.localeCompare(b.rec.date) || a.min - b.min);
      if (mode === "start") {
        for (let i = 0; i < list.length; i++) {
          const cur = list[i];
          const next = list[i + 1];
          /* 全部记录里最晚的一条后面没有「下一条」，无法成段 */
          if (!next) break;
          let endMin = next.min;
          let endText = next.rec.time;
          if (next.rec.date !== cur.rec.date) {
            /* 跨天：当天只算到 24:00，00:00 起的余下一段挂到次日开头 */
            endMin = 24 * 60;
            endText = "24:00";
          }
          const dur = endMin - cur.min;
          if (dur > 0) {
            perRecord.set(cur.rec.id, {
              range: `${cur.rec.time} - ${endText}`,
              durText: fmtDur(dur),
            });
          }
          if (next.rec.date !== cur.rec.date && next.min > 0) {
            carries.set(next.rec.date, {
              range: `00:00 - ${next.rec.time}`,
              durText: fmtDur(next.min),
              fromDate: cur.rec.date,
              fromTime: cur.rec.time,
            });
          }
        }
      } else {
        for (let i = 1; i < list.length; i++) {
          const cur = list[i];
          const prev = list[i - 1];
          /* 只认同日上一条：隔夜的时长挂到次日第一条会横跨一整晚，不硬接 */
          if (prev.rec.date !== cur.rec.date) continue;
          const dur = cur.min - prev.min;
          if (dur <= 0) continue;
          perRecord.set(cur.rec.id, {
            range: `${prev.rec.time} - ${cur.rec.time}`,
            durText: fmtDur(dur),
          });
        }
      }
      return { perRecord, carries };
    }

    /* 渲染 Dock 时间轴列表（复刻轻语时间轴样式） */
    _renderLifeLogDockList(listEl, records) {
      if (!listEl) return;
      /* 区间与「持续」先在完整记录上算好，再按日期筛选 ——
         开始模式里「当天最后一条」的时长要接到次日第一条上，先筛就没有「次日」了 */
      const parts = this._lifelogTimelineParts(records || []);
      let data = records || [];
      if (this._lifelogDockDateFilter) {
        data = data.filter((r) => r.date === this._lifelogDockDateFilter);
      }
      if (!data || data.length === 0) {
        listEl.innerHTML = '<div class="north-lifelog-timeline-empty">暂无记录，点击右下角 + 开始记录</div>';
        return;
      }
      const esc = (s) =>
        String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      /* 按日期分组，同组按时间倒序 */
      const groups = {};
      data.forEach((r) => {
        if (!groups[r.date]) groups[r.date] = [];
        groups[r.date].push(r);
      });
      Object.values(groups).forEach((arr) => arr.sort((a, b) => b.time.localeCompare(a.time)));
      const sortedDates = Object.keys(groups).sort((a, b) => b.localeCompare(a));
      /* 跨天延续行（仅开始模式会有）：延续昨日最后一条记录、落在这一天里的部分 */
      const carryHtml = (carry) => {
        const rangeHtml = `${carry.range}<span class="north-lifelog-timeline-duration">持续：${carry.durText}</span>`;
        return `<div class="north-lifelog-timeline-item north-lifelog-timeline-item--carry">
                    <div class="north-lifelog-timeline-left">
                        <span class="north-lifelog-timeline-time">00:00</span>
                    </div>
                    <div class="north-lifelog-timeline-axis">
                        <div class="north-lifelog-timeline-marker"></div>
                    </div>
                    <div class="north-lifelog-timeline-card">
                        <div class="north-lifelog-timeline-range">${rangeHtml}</div>
                        <div class="north-lifelog-timeline-content">延续 ${esc(carry.fromDate)} ${esc(carry.fromTime)} 起的记录</div>
                    </div>
                </div>`;
      };
      let html = "";
      sortedDates.forEach((date) => {
        const items = groups[date];
        const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
        const dt = new Date((date || "") + "T00:00:00");
        const dayLabel = isNaN(dt.getTime()) ? "" : " " + weekdays[dt.getDay()];
        html += `<div class="north-lifelog-date-group">${date}${dayLabel}</div>`;
        const carry = parts.carries.get(date);
        if (carry) html += carryHtml(carry);
        items.forEach((item) => {
          const info = parts.perRecord.get(item.id);
          const rangeStr = info && info.range ? info.range : item.time;
          const durationStr = info ? info.durText : "";
          const rangeHtml = `${rangeStr}${durationStr ? `<span class="north-lifelog-timeline-duration">持续：${durationStr}</span>` : ""}`;
          const typeColor = this._dockTypeColor(item.type);
          const typeStyle = typeColor ? ` style="color:${typeColor}"` : "";
          const typeDiv = item.type
            ? `<div class="north-lifelog-timeline-type"${typeStyle}>${esc(item.type)}</div>`
            : "";
          html += `<div class="north-lifelog-timeline-item" data-id="${esc(item.id)}" data-type="${esc(item.type)}">
                    <div class="north-lifelog-timeline-left">
                        <span class="north-lifelog-timeline-time">${item.time}</span>
                    </div>
                    <div class="north-lifelog-timeline-axis">
                        <div class="north-lifelog-timeline-marker"${typeColor ? ' style="--lifelog-timeline-color:' + typeColor + '"' : ""}></div>
                    </div>
                    <div class="north-lifelog-timeline-card">
                        <div class="north-lifelog-timeline-range">${rangeHtml}</div>
                        ${typeDiv}
                        <div class="north-lifelog-timeline-content">${esc(item.content)}</div>
                    </div>
                </div>`;
        });
      });
      listEl.innerHTML = html;
    }

    /* 悬浮添加按钮：取可用类型。
       只保留「真正有记录」的类型：统计每个类型在最近记录中出现的条数，
       条数 >= 1 才进候选；在类型管理里配置过、但一条记录都没有的类型不再显示。
       兜底：一个类型都没产生过记录（含记录数据尚未加载完的情况）时，
       退回显示用户配置的全部类型，否则面板会空掉、连新建记录都选不了类型。
       注意：计数范围是 Dock 一次查询上限的最近 200 条记录，
       很久没用过的类型会自然沉底，不再出现在面板里。 */
    _dockPickTypes() {
      const used = [];
      const cached = this._lifelogDockCache;
      if (Array.isArray(cached)) {
        const count = new Map();
        cached.forEach((r) => {
          const t = ((r && r.type) || "").trim();
          if (!t) return;
          count.set(t, (count.get(t) || 0) + 1);
        });
        count.forEach((n, t) => {
          if (n >= 1) used.push(t);
        });
      }
      if (used.length) return used.sort();
      /* 兜底：退回配置类型 */
      const set = new Set();
      (this.data.typeGroups || []).forEach((g) => {
        (g.items || []).forEach((i) => {
          const n = ((i && i.name) || "").trim();
          if (n) set.add(n);
        });
      });
      return Array.from(set).sort();
    }

    /* Dock 悬浮添加按钮点击（与轻语同款逻辑） */
    _bindLifeLogDockFabClick(root) {
      const fab = root.querySelector("#lifelogDockFab");
      if (!fab || fab._dockFabBound) return;
      fab._dockFabBound = true;

      const pickOverlay = root.querySelector("#lifelogDockPickOverlay");
      const pickTypes = root.querySelector("#lifelogDockPickTypes");
      const pickClose = root.querySelector("#lifelogDockPickClose");
      const modal = root.querySelector("#lifelogDockInputModal");
      const modalBack = root.querySelector("#lifelogDockInputModalBack");
      const modalCancel = root.querySelector("#lifelogDockInputModalCancel");
      const modalSubmit = root.querySelector("#lifelogDockInputModalSubmit");
      const modalType = root.querySelector("#lifelogDockInputModalType");
      const modalTime = root.querySelector("#lifelogDockInputModalTime");
      const modalTextarea = root.querySelector("#lifelogDockInputModalTextarea");

      let _selType = "";

      const escHtml = (s) =>
        String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

      const openPick = () => {
        const types = this._dockPickTypes();
        if (types.length === 0) {
          _selType = "记录";
          openInput();
          return;
        }
        pickTypes.innerHTML = types
          .map((t) => {
            const color = this._dockTypeColor(t) || "";
            return `<button class="north-lifelog-pick-type-chip" style="color:${color}">${escHtml(t)}</button>`;
          })
          .join("");
        pickTypes.querySelectorAll(".north-lifelog-pick-type-chip").forEach((btn) => {
          btn.addEventListener("click", () => {
            _selType = btn.textContent;
            closePick();
            openInput();
          });
        });
        pickOverlay.style.display = "";
      };

      const closePick = () => {
        pickOverlay.style.display = "none";
      };

      const openInput = () => {
        const now = new Date();
        modalType.textContent = _selType || "记录";
        modalTime.textContent =
          String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
        modalTextarea.value = "";
        modal.style.display = "";
        setTimeout(() => {
          try {
            modalTextarea.focus();
          } catch (e) {}
        }, 100);
      };

      const closeInput = () => {
        modal.style.display = "none";
        modalTextarea.value = "";
        _selType = "";
      };
      const backToPick = () => {
        modal.style.display = "none";
        modalTextarea.value = "";
        _selType = "";
        openPick();
      };
      const closeAll = () => {
        modal.style.display = "none";
        pickOverlay.style.display = "none";
        modalTextarea.value = "";
        _selType = "";
      };

      const submit = async () => {
        const content = modalTextarea.value.trim();
        if (!content) return;
        modalSubmit.disabled = true;
        modalSubmit.textContent = "记录中…";
        try {
          const now = new Date();
          const hh = String(now.getHours()).padStart(2, "0");
          const mm = String(now.getMinutes()).padStart(2, "0");
          const type = _selType || "记录";
          const md = `${hh}:${mm} ${type}：${content}`;
          const info = parseLine(md);
          /* 选目标文档：记录范围放开且当前文档在范围内时写当前文档，
             否则写今日日记（失败原因由 _ensureDailyNote 内部提示） */
          const target = await this._pickRecordTarget();
          if (!target) return;
          /* 追加内容块 */
          const appendResp = await this._request("/api/block/appendBlock", {
            dataType: "markdown",
            data: md,
            parentID: target.docId,
          });
          /* 定位刚追加的段落并立即打标，保证 Dock 列表中马上可见 */
          const blockId = await this._locateAppendedBlock(
            target.docId,
            md,
            appendResp
          );
          if (blockId && info) {
            await this._serial(target.docId, () =>
              this._tagBlock(blockId, info, target.date)
            );
          }
          closeAll();
          showMessage(`${NAME}：已记录`);
          /* 留点时间等思源把新块的属性索引好，再让列表与日历一起刷新 */
          setTimeout(() => this._notifyRecordsChanged(), 500);
        } catch (e) {
          showMessage(`${NAME}：写入失败：${e.message}`);
        } finally {
          modalSubmit.disabled = false;
          modalSubmit.textContent = "记录";
        }
      };

      /* 事件绑定 */
      fab.addEventListener("click", () => openPick());
      pickClose.addEventListener("click", closeAll);
      pickOverlay.querySelector(".north-lifelog-pick-bg").addEventListener("click", closeAll);
      if (modalBack) modalBack.addEventListener("click", backToPick);
      modalCancel.addEventListener("click", closeAll);
      modal.querySelector(".north-lifelog-input-modal-bg").addEventListener("click", closeAll);
      modalSubmit.addEventListener("click", submit);
      modalTextarea.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          submit();
        }
      });
    }

    /* 定位刚追加的块 ID：优先从 append 返回结构解析，失败则按内容 SQL 回查 */
    async _locateAppendedBlock(docId, md, appendResp) {
      try {
        const ops = Array.isArray(appendResp && appendResp.data) ? appendResp.data : [];
        for (const item of ops) {
          const doOps = Array.isArray(item && item.doOperations) ? item.doOperations : [];
          for (const op of doOps) {
            if (op && op.id && this._validId(op.id)) return op.id;
          }
          if (item && item.id && this._validId(item.id)) return item.id;
        }
      } catch (e) {}
      try {
        const safeDoc = String(docId).replace(/[^0-9a-z-]/gi, "");
        const safeMd = String(md || "").replace(/'/g, "''");
        const sql = `SELECT id FROM blocks WHERE root_id = '${safeDoc}' AND type = 'p' AND content = '${safeMd}' ORDER BY updated DESC LIMIT 1`;
        const resp = await this._request("/api/query/sql", { stmt: sql });
        if (resp.code === 0 && resp.data && resp.data[0] && this._validId(resp.data[0].id)) {
          return resp.data[0].id;
        }
      } catch (e) {}
      return "";
    }

    /* ============================================================
     * LifeLog Dock · 统计视图（参考轻语 renderLifeLogStats）
     * ============================================================ */

    /* 计算周期范围与每日条数（依据 period + anchor） */
    _computeLifeLogDockPeriod(period, anchor) {
      const a = new Date(anchor || new Date());
      const formatKey = (d) =>
        d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      let start, end, label, bars = [];
      if (period === "day") {
        start = new Date(a.getFullYear(), a.getMonth(), a.getDate(), 0, 0, 0, 0);
        end = new Date(a.getFullYear(), a.getMonth(), a.getDate(), 23, 59, 59, 999);
        bars.push({ key: formatKey(a), label: "今天", date: new Date(a) });
        label = `${a.getFullYear()}年${a.getMonth() + 1}月${a.getDate()}日`;
      } else if (period === "week") {
        const dow = a.getDay();
        const off = dow === 0 ? -6 : 1 - dow;
        start = new Date(a);
        start.setDate(a.getDate() + off);
        start.setHours(0, 0, 0, 0);
        end = new Date(start);
        end.setDate(start.getDate() + 6);
        end.setHours(23, 59, 59, 999);
        const dayLabels = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
        for (let i = 0; i < 7; i++) {
          const d = new Date(start);
          d.setDate(start.getDate() + i);
          bars.push({ key: formatKey(d), label: dayLabels[i], date: d });
        }
        label = `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日 ~ ${end.getMonth() + 1}月${end.getDate()}日`;
      } else if (period === "month") {
        start = new Date(a.getFullYear(), a.getMonth(), 1, 0, 0, 0, 0);
        end = new Date(a.getFullYear(), a.getMonth() + 1, 0, 23, 59, 59, 999);
        const daysInMonth = end.getDate();
        for (let i = 1; i <= daysInMonth; i++) {
          const d = new Date(a.getFullYear(), a.getMonth(), i);
          bars.push({ key: formatKey(d), label: i + "", date: d });
        }
        label = `${a.getFullYear()}年${a.getMonth() + 1}月`;
      } else if (period === "year") {
        start = new Date(a.getFullYear(), 0, 1, 0, 0, 0, 0);
        end = new Date(a.getFullYear(), 11, 31, 23, 59, 59, 999);
        const monthLabels = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
        for (let i = 0; i < 12; i++) {
          const d = new Date(a.getFullYear(), i, 1);
          bars.push({ key: "M" + (i + 1), label: monthLabels[i], date: d, month: i + 1 });
        }
        label = `${a.getFullYear()}年`;
      } else {
        /* total：按最近 12 个月聚合 */
        start = new Date(a.getFullYear(), a.getMonth() - 11, 1, 0, 0, 0, 0);
        end = new Date(a.getFullYear(), a.getMonth() + 1, 0, 23, 59, 59, 999);
        const monthLabels = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
        for (let i = 0; i < 12; i++) {
          const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
          bars.push({
            key: "M" + (d.getMonth() + 1) + "_" + d.getFullYear(),
            label: monthLabels[d.getMonth()],
            date: d,
            month: d.getMonth() + 1,
            year: d.getFullYear(),
          });
        }
        label = `${start.getFullYear()}年${start.getMonth() + 1}月 ~ ${end.getFullYear()}年${end.getMonth() + 1}月`;
      }
      return { start, end, label, bars };
    }

    /* 根据日期范围过滤缓存中的记录 */
    _filterLifeLogDockByRange(records, start, end) {
      if (!records || !records.length) return [];
      const sMs = start.getTime();
      const eMs = end.getTime();
      return records.filter((r) => {
        if (!r.date) return false;
        const d = new Date(r.date + "T00:00:00");
        const t = d.getTime();
        return t >= sMs && t <= eMs;
      });
    }

    /* 渲染 Dock 统计视图主入口 */
    _renderLifeLogDockStats(root) {
      const statsEl = root.querySelector("#north-lifelog-dock-stats");
      if (!statsEl) return;
      if (!this._lifelogDockStatsPeriod) this._lifelogDockStatsPeriod = "week";
      if (!this._lifelogDockStatsAnchor) this._lifelogDockStatsAnchor = new Date();
      const period = this._lifelogDockStatsPeriod;
      const { start, end, label, bars } = this._computeLifeLogDockPeriod(period, this._lifelogDockStatsAnchor);
      const records = this._filterLifeLogDockByRange(this._lifelogDockCache || [], start, end);
      const dayCount = {};
      records.forEach((r) => {
        dayCount[r.date] = (dayCount[r.date] || 0) + 1;
      });
      const monthCount = {};
      records.forEach((r) => {
        const m = r.date ? r.date.substring(0, 7) : "";
        if (m) monthCount[m] = (monthCount[m] || 0) + 1;
      });
      const maxBar = Math.max(
        1,
        ...bars.map((b) => {
          if (period === "year" || period === "total") {
            return monthCount[(b.year || b.date.getFullYear()) + "-" + String(b.month).padStart(2, "0")] || 0;
          }
          return dayCount[b.key] || 0;
        })
      );
      const barHtml = bars
        .map((b) => {
          let cnt = 0;
          if (period === "year") cnt = monthCount[b.date.getFullYear() + "-" + String(b.month).padStart(2, "0")] || 0;
          else if (period === "total") cnt = monthCount[(b.year || b.date.getFullYear()) + "-" + String(b.month).padStart(2, "0")] || 0;
          else cnt = dayCount[b.key] || 0;
          const percentage = maxBar > 0 ? Math.round((cnt / maxBar) * 100) : 0;
          const tooltip = `${b.key}: ${cnt}条`;
          return `<div class="north-shuoshuo-daily-bar" data-lumina-tip="${tooltip}">
                    <div class="north-shuoshuo-daily-bar-bg">
                        <div class="north-shuoshuo-daily-bar-fill" style="height: ${percentage}%"></div>
                    </div>
                    <span class="north-shuoshuo-daily-bar-count">${cnt}</span>
                    <span class="north-shuoshuo-daily-bar-label">${b.label}</span>
                </div>`;
        })
        .join("");
      const periodDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
      const uniqueDays = Object.keys(dayCount).length;
      const totalCount = records.length;
      const avgPerDay = (totalCount / periodDays).toFixed(1);
      const avgGap = totalCount > 1 ? (periodDays / (totalCount - 1)).toFixed(1) : "0.0";
      const heatHtml = this._renderLifeLogDockHeatmap(this._lifelogDockStatsAnchor);
      statsEl.innerHTML = `
            <div class="north-lifelog-dock-stat-periods">
                <button class="north-lifelog-dock-stat-period ${period === "week" ? "active" : ""}" data-period="week">周</button>
                <button class="north-lifelog-dock-stat-period ${period === "month" ? "active" : ""}" data-period="month">月</button>
                <button class="north-lifelog-dock-stat-period ${period === "year" ? "active" : ""}" data-period="year">年</button>
            </div>
            <div class="north-lifelog-dock-stat-nav">
                <button class="north-lifelog-dock-stat-nav-btn" id="lifelog-dock-stat-prev"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><use xlink:href="#iconLeft"></use></svg></button>
                <span class="north-lifelog-dock-stat-nav-label">${label}</span>
                <button class="north-lifelog-dock-stat-nav-btn" id="lifelog-dock-stat-next"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><use xlink:href="#iconRight"></use></svg></button>
            </div>
            <div class="north-lifelog-dock-stat-chart">
                <div class="north-lifelog-dock-stat-bars">${barHtml}</div>
            </div>
            <div class="north-lifelog-dock-stat-cards">
                <div class="north-lifelog-dock-stat-card">
                    <div class="north-lifelog-dock-stat-card-value">${totalCount} <span class="north-lifelog-dock-stat-card-unit">次</span></div>
                    <div class="north-lifelog-dock-stat-card-label">记录次数</div>
                </div>
                <div class="north-lifelog-dock-stat-card">
                    <div class="north-lifelog-dock-stat-card-value">${uniqueDays} <span class="north-lifelog-dock-stat-card-unit">天</span></div>
                    <div class="north-lifelog-dock-stat-card-label">记录天数</div>
                </div>
                <div class="north-lifelog-dock-stat-card">
                    <div class="north-lifelog-dock-stat-card-value">${avgPerDay} <span class="north-lifelog-dock-stat-card-unit">次</span></div>
                    <div class="north-lifelog-dock-stat-card-label">每日平均</div>
                </div>
                <div class="north-lifelog-dock-stat-card">
                    <div class="north-lifelog-dock-stat-card-value">${avgGap} <span class="north-lifelog-dock-stat-card-unit">天</span></div>
                    <div class="north-lifelog-dock-stat-card-label">平均间隔</div>
                </div>
            </div>
            <div class="north-lifelog-dock-stat-heatmap">
                <div class="north-lifelog-dock-stat-heatmap-title">统计 ›</div>
                ${heatHtml}
            </div>
        `;
      statsEl.querySelectorAll(".north-lifelog-dock-stat-period").forEach((btn) => {
        btn.addEventListener("click", () => {
          this._lifelogDockStatsPeriod = btn.dataset.period;
          this._lifelogDockStatsAnchor = new Date();
          this._renderLifeLogDockStats(root);
        });
      });
      const prevBtn = statsEl.querySelector("#lifelog-dock-stat-prev");
      const nextBtn = statsEl.querySelector("#lifelog-dock-stat-next");
      if (prevBtn && period !== "total") {
        prevBtn.addEventListener("click", () => this._navLifeLogDockStats(-1));
      } else if (prevBtn) {
        prevBtn.style.opacity = "0.3";
        prevBtn.disabled = true;
      }
      if (nextBtn && period !== "total") {
        nextBtn.addEventListener("click", () => this._navLifeLogDockStats(1));
      } else if (nextBtn) {
        nextBtn.style.opacity = "0.3";
        nextBtn.disabled = true;
      }
    }

    /* 统计 anchor 周期加减 */
    _navLifeLogDockStats(delta) {
      const period = this._lifelogDockStatsPeriod || "week";
      const anchor = new Date(this._lifelogDockStatsAnchor || new Date());
      if (period === "week") anchor.setDate(anchor.getDate() + 7 * delta);
      else if (period === "month") anchor.setMonth(anchor.getMonth() + delta);
      else if (period === "year") anchor.setFullYear(anchor.getFullYear() + delta);
      this._lifelogDockStatsAnchor = anchor;
      const root = this._lifeLogDockEl;
      if (root) this._renderLifeLogDockStats(root);
    }

    /* 渲染底部热力图（近 12 个月） */
    _renderLifeLogDockHeatmap(anchor) {
      const a = anchor || new Date();
      const year = a.getFullYear();
      const month = a.getMonth();
      const monthNames = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];
      const dayCount = {};
      (this._lifelogDockCache || []).forEach((r) => {
        if (!r.date) return;
        dayCount[r.date] = (dayCount[r.date] || 0) + 1;
      });
      const maxDay = Math.max(1, ...Object.values(dayCount));
      const renderMonth = (offset) => {
        const m = month + offset;
        const d = new Date(year, m, 1);
        const y = d.getFullYear();
        const mo = d.getMonth();
        const daysInMonth = new Date(y, mo + 1, 0).getDate();
        const firstDow = d.getDay();
        const cells = [];
        for (let i = 0; i < firstDow; i++) cells.push('<div class="north-lifelog-dock-stat-heatmap-cell empty"></div>');
        for (let day = 1; day <= daysInMonth; day++) {
          const key = y + "-" + String(mo + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0");
          const cnt = dayCount[key] || 0;
          let level = "";
          if (cnt > 0) {
            const lvl = Math.min(4, Math.ceil((cnt / maxDay) * 4));
            level = "level-" + lvl;
          }
          cells.push(`<div class="north-lifelog-dock-stat-heatmap-cell ${level}" data-tip="${key} · ${cnt > 0 ? cnt + " 条记录" : "暂无记录"}"></div>`);
        }
        return `<div class="north-lifelog-dock-stat-heatmap-month">
                    <div class="north-lifelog-dock-stat-heatmap-month-title">${monthNames[mo]}</div>
                    <div class="north-lifelog-dock-stat-heatmap-grid">${cells.join("")}</div>
                </div>`;
      };
      return `<div class="north-lifelog-dock-stat-heatmap-row">
            ${Array.from({ length: 12 }, (_, i) => renderMonth(i - month)).join("")}
        </div>`;
    }

    /* ===================== 日记文档 ===================== */

    _validId(id) {
      return ID_RE.test(id || "");
    }

    _getNotebook() {
      const id = (this.data.notebook || "").trim();
      return this._validId(id) ? id : "";
    }

    /* 读取文档元信息（带缓存）：
       { date: YYYY-MM-DD, daily: boolean, box: 笔记本ID, title: 文档标题 }
       daily 表示是否为每日笔记（带 custom-dailynote-YYYYMMDD 属性）。 */
    async _docMetaOf(docId) {
      if (!this._validId(docId)) {
        return { date: formatDate(), daily: false, box: "", title: "" };
      }
      if (this._docMeta.has(docId)) return this._docMeta.get(docId);
      /* 请求期间先占位一个 Promise；resolve 后把缓存替换成「已解析对象」，
         这样 _inScopeCached() 这类不需要 await 的同步路径才能读到结果。 */
      const pending = this._fetchDocMeta(docId)
        .then((meta) => {
          this._docMeta.set(docId, meta);
          return meta;
        })
        .catch((e) => {
          this._docMeta.delete(docId); /* 失败不缓存，允许下次重试 */
          console.warn(`${NAME}：读取文档属性失败`, e);
          return { date: formatDate(), daily: false, box: "", title: "" };
        });
      this._docMeta.set(docId, pending);
      return pending;
    }

    async _fetchDocMeta(docId) {
      const created = compactDate(String(docId).slice(0, 8));
      if (!this._validId(docId)) {
        return { date: created || formatDate(), daily: false, box: "", title: "" };
      }
      /* 1. 文档属性：找 custom-dailynote-YYYYMMDD（键名或取值命中都算日记） */
      let dailyDate = "";
      try {
        const resp = await this._request("/api/attr/getBlockAttrs", { id: docId });
        const attrs = resp.data && typeof resp.data === "object" ? resp.data : {};
        for (const key of Object.keys(attrs)) {
          if (key.indexOf("custom-dailynote-") !== 0) continue;
          dailyDate =
            compactDate(key.slice("custom-dailynote-".length)) ||
            compactDate(attrs[key]);
          if (dailyDate) break;
        }
      } catch (e) {
        console.warn(`${NAME}：读取文档属性失败`, e);
      }
      /* 2. 所属笔记本与标题：前者供「指定笔记本」范围用，后者供日期推断用 */
      let box = "";
      let title = "";
      try {
        const resp = await this._request("/api/query/sql", {
          stmt: `SELECT box, content FROM blocks WHERE id = '${docId}'`,
        });
        const rows = resp.code === 0 && Array.isArray(resp.data) ? resp.data : [];
        if (rows[0]) {
          box = rows[0].box || "";
          title = rows[0].content || "";
        }
      } catch (e) {
        console.warn(`${NAME}：读取文档位置失败`, e);
      }
      /* 3. 日期优先级：日记属性 > 标题里的日期 > 文档创建日 > 今天 */
      const date = dailyDate || dateFromText(title) || created || formatDate();
      return { date, daily: !!dailyDate, box, title };
    }

    /* 当前记录范围：daily（仅日记）/ notebook（指定笔记本）/ all（全部文档） */
    _recordScope() {
      return normRecordScope(this.data && this.data.recordScope);
    }

    /* 文档是否落在记录范围内。
       notebook 档若没选笔记本，退回「仅日记」判定，避免整档失效。 */
    _inScope(meta) {
      if (!meta) return false;
      const scope = this._recordScope();
      if (scope === "all") return true;
      if (scope === "notebook") {
        const notebook = this._getNotebook();
        if (!notebook) return !!meta.daily;
        return !!meta.box && meta.box === notebook;
      }
      return !!meta.daily;
    }

    /* 同步版的「该文档是否在记录范围内」：只读已就绪的缓存，不发请求。
       返回 true / false；缓存还是 Promise（请求进行中）时返回 null 表示未知。 */
    _inScopeCached(docId) {
      if (!this._validId(docId)) return null;
      const cached = this._docMeta.get(docId);
      if (!cached || typeof cached.then === "function") return null;
      return this._inScope(cached);
    }

    /* 当前范围下一篇都没命中时的提示语，按范围给出可操作的下一步 */
    _scopeMissHint() {
      const scope = this._recordScope();
      if (scope === "notebook" && !this._getNotebook()) {
        return "请先在设置中选择笔记本，或把「记录范围」改成「全部文档」";
      }
      if (scope === "notebook") {
        return "当前打开的文档不在所选笔记本内，请检查「记录范围」与笔记本设置";
      }
      if (scope === "all") {
        return "当前打开的文档里没有可处理的段落";
      }
      return "当前打开的文档不是每日笔记；想在别的文档里也能记录，请把设置中的「记录范围」改为「指定笔记本」或「全部文档」";
    }

    /* 当前正在编辑的文档 ID。多标签并存时，隐藏的编辑器 offsetParent 为 null，
       会被排除，因此优先取可见的那个。 */
    _activeDocId() {
      const editors = Array.from(document.querySelectorAll(".protyle-wysiwyg"));
      for (const el of editors) {
        if (el.offsetParent === null) continue;
        const id = this._docIdOf(el);
        if (this._validId(id)) return id;
      }
      /* 兜底：都判不出可见性时，取第一个能解析出 ID 的编辑器 */
      for (const el of editors) {
        const id = this._docIdOf(el);
        if (this._validId(id)) return id;
      }
      return "";
    }

    /* Dock「＋添加记录」的写入目标。
       记录范围放开后优先写「当前打开的文档」——所见即所记；
       当前文档不在范围内、或没打开文档时，回落到今日日记。
       返回 { docId, date }，失败时返回 null（提示已在内部发出）。 */
    async _pickRecordTarget() {
      if (this._recordScope() !== "daily") {
        const currentId = this._activeDocId();
        if (currentId) {
          const meta = await this._docMetaOf(currentId);
          if (this._inScope(meta)) {
            return { docId: currentId, date: meta.date };
          }
        }
      }
      const docId = await this._ensureDailyNote();
      if (!docId) return null;
      const meta = await this._docMetaOf(docId);
      return { docId, date: meta.date || formatDate() };
    }

    /* 创建或打开今日日记并补记 custom-dailynote 属性；失败返回空串。
       createDailyNote 成功时若文档已存在会直接返回其 ID，因此本方法可重复调用。 */
    async _ensureDailyNote() {
      const notebook = this._getNotebook();
      if (!notebook) {
        showMessage(`${NAME}：请先在插件设置中选择日记笔记本`);
        this._openSettings();
        return "";
      }
      try {
        await this._request("/api/notebook/openNotebook", { notebook });
      } catch (e) {
        /* 已打开的笔记本会报错，这里忽略；其它错误留给下一步暴露 */
      }
      let docId = "";
      try {
        const resp = await this._request("/api/filetree/createDailyNote", {
          notebook,
        });
        docId = resp.data && resp.data.id ? resp.data.id : "";
      } catch (e) {
        showMessage(
          `${NAME}：创建今日日记失败：${this._dailyNoteErrorHint(e.message)}`
        );
        return "";
      }
      if (!this._validId(docId)) {
        showMessage(`${NAME}：创建今日日记失败：返回数据异常`);
        return "";
      }
      await this._markDaily(docId);
      return docId;
    }

    /* 内核报错翻译：createDailyNote 的失败原因偏隐晦，这里补上可照做的下一步。
       两种常见情况：笔记本未设置每日笔记保存路径、笔记本不存在。 */
    _dailyNoteErrorHint(msg) {
      const m = String(msg || "").trim();
      if (/路径/.test(m)) {
        return `${m}（可在「文档树」右键该笔记本 → 设置里填写每日笔记保存路径；或把插件设置里的「记录范围」改为「全部文档」，记录就不再依赖日记）`;
      }
      if (/notebook not found|笔记本不存在/i.test(m)) {
        return "所选日记笔记本不存在或已被删除，请在插件设置中重新选择";
      }
      return m || "未知错误";
    }

    /* 若文档尚未带 custom-dailynote-YYYYMMDD 属性，则补上今日日期标记 */
    async _markDaily(docId) {
      try {
        const meta = await this._docMetaOf(docId);
        if (meta.daily) return;
        const compact = today();
        await this._request("/api/attr/setBlockAttrs", {
          id: docId,
          attrs: { [`custom-dailynote-${compact}`]: compact },
        });
        /* 属性已变，缓存整体作废后重拉 —— 只改 date 会把 box / 标题丢掉，
           那样「指定笔记本」范围会判定失效。 */
        this._docMeta.delete(docId);
      } catch (e) {
        console.warn(`${NAME}：写入日记日期属性失败`, e);
      }
    }

    async _openDailyNote() {
      const docId = await this._ensureDailyNote();
      if (!docId) return;
      if (typeof openTab === "function") {
        openTab({ app: this.app, doc: { id: docId, action: ["cb-get-hl"] } });
      }
    }

    /* ===================== 打标核心 ===================== */

    /* 当前生效的属性名前缀（兜底默认 lifelog） */
    _attrPfx() {
      return normAttrPrefix(this.data && this.data.attrPrefix);
    }

    /* 按 key 生成块属性名：custom-<前缀>-<key> */
    _attr(key) {
      return `custom-${this._attrPfx()}-${key}`;
    }

    /* 判断现有属性是否已是最新，避免无意义重复写入 */
    _isFresh(existing, info, date) {
      return (
        existing[this._attr("content")] === info.content &&
        existing[this._attr("type")] === info.type &&
        existing[this._attr("time")] === info.time &&
        existing[this._attr("date")] === date
      );
    }

    /* 为单个块写入或刷新属性。
       返回 tagged（新打标）/ unchanged（已是最新）/ failed（失败）。 */
    async _tagBlock(blockId, info, date) {
      if (!this._validId(blockId)) return "failed";
      let existing = {};
      try {
        const resp = await this._request("/api/attr/getBlockAttrs", {
          id: blockId,
        });
        existing = resp.data && typeof resp.data === "object" ? resp.data : {};
      } catch (e) {
        return "failed";
      }
      if (this._isFresh(existing, info, date)) return "unchanged";
      const now = formatDateTime();
      try {
        await this._request("/api/attr/setBlockAttrs", {
          id: blockId,
          attrs: {
            [this._attr("content")]: info.content,
            [this._attr("type")]: info.type,
            [this._attr("time")]: info.time,
            [this._attr("date")]: date,
            [this._attr("created")]: existing[this._attr("created")] || now,
            [this._attr("updated")]: now,
          },
        });
        return "tagged";
      } catch (e) {
        return "failed";
      }
    }

    /* 同一文档内的写操作串行执行，返回本次任务结果 */
    _serial(docId, task) {
      const prev = this._serialQueues.get(docId) || Promise.resolve();
      const next = prev.then(task);
      this._serialQueues.set(
        docId,
        next.then(
          () => {},
          () => {}
        )
      );
      return next;
    }

    /* ===================== DOM 自动识别 ===================== */

    /* 从段落向上定位所在文档 ID */
    _docIdOf(node) {
      const protyle = node.closest
        ? node.closest(".protyle")
        : null;
      if (!protyle) return "";
      const inst = protyle.protyle;
      if (inst && inst.block && this._validId(inst.block.rootID)) {
        return inst.block.rootID;
      }
      const title = protyle.querySelector(".protyle-title");
      const id = title && title.getAttribute("data-node-id");
      return this._validId(id) ? id : "";
    }

    /* 段落是不是落在「思维导图视图 / 思维导图块」里。
       这个范围要整段跳过、一点都不碰 —— 原因是思源给脑图节点的编辑做了一条
       「进入编辑那一刻，节点块的 outerHTML 快照」校验：保存前如果节点的
       outerHTML 变了，就认定内容被外部改过，弹「内容已更新，请重新编辑」
       并放弃这一次输入（思源源码 app/src/protyle/render/listMindmap/editor.ts
       里的 nodeContent() / comparableContent() 对比 + listMindmapStale 文案）。
       而我们给段落加的类名（tt-hit / tt-nomark）和内联变量（--tt-c）都会进
       outerHTML，于是打字打到一半就被判成「内容已更新」，表现就是输入发卡、
       回车换行后报错；同理，往脑图节点的块上写记录属性也会触发同一条判定。
       所以脑图范围里一律不上色、不打标、不写属性 —— 反正节点预览是源块的克隆，
       类名和块属性都会照旧带过去，样式表照样给容器里的 .protyle-wysiwyg
       段落上色，看起来和列表视图一致，只是不再由脚本现场改 DOM。
       注意范围记号两代不同名（见 LIST_MINDMAP_SELECTOR），两代都要认。 */
    _isInListMindmap(node) {
      return !!(
        node &&
        typeof node.closest === "function" &&
        node.closest(LIST_MINDMAP_SELECTOR)
      );
    }

    _clearMark(p) {
      /* 脑图范围一次 DOM 都不改（原因见 _isInListMindmap） */
      if (this._isInListMindmap(p)) return;
      p.classList.remove("tt-hit");
      /* 段落上可能仍留着记录类型属性，而样式表会照属性直接上色
         （这是「刷新即显示」的来源），所以范围外或不再命中的段落
         要用这个类把属性选择器压掉。属性本身不删 —— 数据不丢，只是不再显示。 */
      p.classList.add("tt-nomark");
      /* 清理旧版本残留的内联变量：颜色现在由样式表按块属性给出 */
      p.style.removeProperty("--tt-c");
    }

    /* 命中记录行格式时只打一个类名，颜色交给样式表的属性选择器 */
    _applyMark(p) {
      /* 脑图范围一次 DOM 都不改（原因见 _isInListMindmap） */
      if (this._isInListMindmap(p)) return;
      p.classList.remove("tt-nomark");
      p.classList.add("tt-hit");
    }

    /* 当前生效的下划线线宽（px），默认 0.75；0 = 无（不画线） */
    _lineWidth() {
      return normLineWidth(this.data && this.data.markLineWidth);
    }

    /* 当前生效的记录行底色深浅（1 到 10 的整数），0 表示关闭 */
    _bgOpacity() {
      return normBgOpacity(this.data && this.data.markBgOpacity);
    }

    /* 当前生效的时间计算模式：end 结束模式（默认）/ start 开始模式 */
    _timeCalcMode() {
      return normTimeMode(this.data && this.data.timeCalcMode);
    }

    /* 按当前前缀与类型配色，生成「块属性 到 --tt-c」的映射规则，形如：
         .protyle-wysiwyg [data-type="NodeParagraph"][custom-lifelog-type="学习"] { --tt-c: #95de64; }
       前缀与颜色都可配置，所以这里动态生成，而不是写死在 index.css。
       同名类型以首次出现的配色为准，与 _colorOf 的查找顺序保持一致。
       --tt-c 缺失时的兜底用插件默认类型色，不要用主题主色 ——
       在类型管理里删掉某个类型后，文档里它的历史记录会匹配不到规则，
       用主题主色会让它们突然变成思源的主题蓝，看着像配色出错。 */
    _ensureMarkStyle() {
      if (typeof document === "undefined" || !document.head) return;
      let el = document.getElementById(MARK_STYLE_ID);
      if (!el) {
        el = document.createElement("style");
        el.id = MARK_STYLE_ID;
        document.head.appendChild(el);
      }
      const attr = this._attr("type");
      const seen = new Set();
      const bg = this._bgOpacity();
      const lineW = this._lineWidth();
      /* 线宽选「无」时，线色直接给 transparent —— 内阴影即使宽度为 0 也仍然
         声明着，压成透明最稳，不依赖浏览器怎么处理 0 尺寸的内阴影。 */
      const noLine = !(lineW > 0);
      const rules = [
        /* 线宽、线色与底色由设置里的「下划线粗细」「记录底色」决定；
           底色档位为 0（关闭）时输出 transparent，等价于不上底色，底边线不受影响；
           线宽为「无」时线色压成 transparent，标记本身照旧（属性不删、底色照上，
           各视图也不受影响）—— 与别的插件同开时不会再叠出一条粗线。
           选择器同时覆盖两种情况：
           1) .tt-hit —— JS 即时打标，用于「刚输入、块属性还没写进库」的那一瞬间；
           2) 带记录类型属性的段落 —— 思源渲染文档时属性就已经在 DOM 上了，
              靠它让下划线与文字同时出现，不必等异步扫描补标
              （否则刷新后会先有文字、过一会儿才浮出下划线）。
           范围外的段落由 JS 挂 .tt-nomark 压掉；属性本身不删，数据不丢。 */
        [
          `.protyle-wysiwyg [data-type="NodeParagraph"].tt-hit,`,
          `.protyle-wysiwyg [data-type="NodeParagraph"][${attr}]:not(.tt-nomark) {`,
          `  --tt-line-w: ${noLine ? 0 : lineW}px;`,
          `  --tt-line: ${
            noLine
              ? "transparent"
              : `color-mix(in srgb, var(--tt-c, ${DEFAULT_TYPE_COLOR}) ${MARK_LINE_MIX}%, transparent)`
          };`,
          `  --tt-bg: ${
            bg > 0
              ? `color-mix(in srgb, var(--tt-c, ${DEFAULT_TYPE_COLOR}) ${bg}%, transparent)`
              : "transparent"
          };`,
          `  background-color: var(--tt-bg, transparent);`,
          `  border-radius: 6px;`,
          `  box-shadow: inset 0 calc(-1 * var(--tt-line-w, 0.75px)) 0 0 var(--tt-line, transparent);`,
          `}`,
        ].join("\n"),
      ];
      for (const g of this.data.typeGroups || []) {
        for (const it of g.items || []) {
          if (!it || !it.name || seen.has(it.name)) continue;
          const color =
            safeColor(it.color) || safeColor(g.color) || DEFAULT_TYPE_COLOR;
          seen.add(it.name);
          rules.push(
            `.protyle-wysiwyg [data-type="NodeParagraph"][${attr}="${cssAttrValue(
              it.name
            )}"] { --tt-c: ${color}; }`
          );
        }
      }
      el.textContent = rules.join("\n");
    }

    /* 输入/换行时同步刷新段落的视觉标记（不发请求、不持久化属性），
       用来抵消 600ms 防抖带来的滞后。
       注意：这里必须一并判定「记录范围」—— 只按文本格式打标的话，
       范围外的文档会先亮起下划线与底色，等 _handleParagraph 判定完再消失，
       表现为「回车里闪一下」。 */
    _refreshVisualMark(p) {
      if (!p || typeof p.getAttribute !== "function") return;
      /* 脑图范围里的段落不动手：改了 outerHTML 会把思源的节点编辑判成
         「内容已更新，请重新编辑」（原因见 _isInListMindmap） */
      if (this._isInListMindmap(p)) return;
      /* 看的是「时间 类型：」有没有齐 —— 类型一敲定就算过关，不等内容写完。
         颜色当场按类型配置内联写上，所以下划线出现时就是对色，
         不会先落一个「未配置类型」的兜底灰、等属性入库再变。 */
      const typed = parseTypePrefix(p.textContent || "");
      if (!typed) {
        this._clearMark(p);
        return;
      }
      const inScope = this._inScopeCached(this._docIdOf(p));
      if (inScope === false) {
        this._clearMark(p);
        return;
      }
      /* inScope === null（元信息还在请求中）也先上色，
         交给稍后的 _handleParagraph 给出确定结果 */
      p.style.setProperty("--tt-c", this._colorOf(typed.type) || DEFAULT_TYPE_COLOR);
      p.classList.remove("tt-nomark");
      p.classList.add("tt-hit");
    }

    /* 处理一个段落：在「记录范围」内的文档中给命中的段落打标并加下划线。
       范围默认是「仅日记」，可在设置里放开到「指定笔记本」或「全部文档」。 */
    async _handleParagraph(p) {
      try {
        if (!p || typeof p.getAttribute !== "function") return;
        /* 脑图范围里的段落不处理：既不上色，也不写块属性 ——
           写属性同样会让思源判定「内容已更新，请重新编辑」（原因见 _isInListMindmap） */
        if (this._isInListMindmap(p)) return;
        const blockId = p.getAttribute("data-node-id");
        const docId = this._docIdOf(p);
        if (!this._validId(blockId) || !this._validId(docId)) return;

        const meta = await this._docMetaOf(docId);
        const raw = p.textContent || "";
        const info = parseLine(raw);
        const typed = parseTypePrefix(raw);
        /* 类型都还没敲定（或落到了记录范围外）就不该有标记 */
        if (!this._inScope(meta) || !typed) {
          this._clearMark(p);
          return;
        }
        this._applyMark(p);
        /* 类型敲定了、内容还没写：先只上色，不入库。
           没有内容就落库的话，侧栏里会冒出一条空的记录。 */
        if (!info) return;
        const state = await this._serial(docId, () =>
          this._tagBlock(blockId, info, meta.date)
        );
        if (state === "tagged") {
          /* 属性已经入库，颜色交给样式表的属性选择器，撤掉临时的内联值 */
          p.style.removeProperty("--tt-c");
          /* 光标还停在这一行就先不刷侧栏 —— 用户还在写，内容会一次次变，
             跟着刷就是一闪一闪；等他换行或移开光标再统一刷一次。 */
          if (this._isEditingParagraph(p)) this._pendingRefreshParas.add(p);
          else this._notifyRecordsChanged();
        }
      } catch (e) {
        console.warn(`${NAME}：处理段落失败`, e);
      }
    }

    /* 记录范围变化后重扫当前打开的编辑器：
       仍在范围内的段落会被打标，落到范围外的则清掉视觉标记
       （已写入的块属性不删，数据不丢，只是不再显示）。 */
    _rescanOpenEditors() {
      document
        .querySelectorAll('.protyle-wysiwyg [data-type="NodeParagraph"]')
        .forEach((p) => this._handleParagraph(p));
    }

    /* 对编辑器区域挂载观察器：打开文档先扫一遍，输入停顿后再处理 */
    _watchEditors() {
      if (this._watching) return;
      this._watching = true;

      /* 光标一动就看看有没有挂起的侧栏刷新要补（回车换行、点到别处都会触发）。
         回调头一句就是查集合大小，没挂起时开销可以忽略。 */
      if (!this._onSelectionChange) {
        this._onSelectionChange = () => this._flushPendingRefreshes();
        document.addEventListener("selectionchange", this._onSelectionChange);
      }

      const observeEditor = (editor) => {
        if (!editor || this._boundEditors.has(editor)) return;
        this._boundEditors.add(editor);

        editor.querySelectorAll('[data-type="NodeParagraph"]').forEach((p) => {
          /* 先同步过一遍，让首帧就接近终态：
             文本已经不符合记录格式的段落立即压掉（它身上可能还留着块属性，
             样式表照属性会画上下划线，等异步判定完再消失就是闪一下）；
             范围已判定的段落也能立刻定下来。属性在的段落由样式表直接着色。 */
          this._refreshVisualMark(p);
          this._handleParagraph(p);
        });

        let timer = null;
        const obs = new MutationObserver((mutations) => {
          const targets = new Set();
          /* 被删掉的段落里有没有「本来就带着记录属性」的：有的话说明列表里那条记录
             已经不存在了，得让它跟着消失。属性只剩在这一刻的 DOM 快照上，
             删除之后就查不到了，所以在这里就判掉。 */
          let removedRecord = false;
          for (const m of mutations) {
            /* 脑图范围内的变动一律略过：那是思源自己在维护节点预览与节点内嵌编辑器，
               我们既不该给它们打标，也不该把它们的增删当成「记录被删了」。
               这里判的是 m.target（变更发生的位置）而不是被增删的那个节点 ——
               节点被移走之后已经脱离文档，那时再 closest() 是认不出脑图容器的
               （脑图刷新节点时正是 replaceChildren，一批旧节点会当场失去父级）。 */
            if (this._isInListMindmap(m.target)) continue;
            if (m.type === "characterData") {
              let p = m.target;
              while (p && p !== editor) {
                if (
                  p.nodeType === 1 &&
                  p.matches &&
                  p.matches('[data-type="NodeParagraph"]')
                ) {
                  targets.add(p);
                  break;
                }
                p = p.parentElement;
              }
            } else if (m.type === "childList") {
              m.addedNodes.forEach((n) => {
                if (n.nodeType !== 1) return;
                if (n.matches && n.matches('[data-type="NodeParagraph"]')) {
                  targets.add(n);
                } else if (n.querySelectorAll) {
                  n.querySelectorAll('[data-type="NodeParagraph"]').forEach(
                    (q) => targets.add(q)
                  );
                }
              });
              m.removedNodes.forEach((n) => {
                if (n.nodeType !== 1 || !n.matches || !n.hasAttribute) return;
                if (
                  n.matches('[data-type="NodeParagraph"]') &&
                  n.hasAttribute(this._attr("type"))
                ) {
                  removedRecord = true;
                }
              });
            }
          }

          /* 记录被删掉了：列表和日历要跟着减一条 */
          if (removedRecord) this._notifyRecordsChanged();

          /* 待处理的段落累积起来，不要每来一批就把上一批丢掉 ——
             用户很可能是「敲完一行立刻回车」，回车带来的新变动会冲掉上一批，
             那一行就再也等不到上色。 */
          targets.forEach((p) => this._typingParas.add(p));

          /* 上色和落库都等停手再做：敲「12:27 学习：」这种半截内容时类型可能
             还没敲全，这会儿上色会先给一个兜底色、敲全了再变，看着就是跳一下。
             停手 1 秒再一起做 —— 此时类型已经定了，下划线一出现就是对色。 */
          clearTimeout(timer);
          timer = setTimeout(() => {
            const pending = Array.from(this._typingParas).filter((p) => p.isConnected);
            this._typingParas.clear();
            pending.forEach((p) => this._refreshVisualMark(p));
            pending.forEach((p) => this._handleParagraph(p));
          }, 1000);
        });
        obs.observe(editor, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        this._observers.push(obs);
      };

      const tryBind = () => {
        const editors = document.querySelectorAll(".protyle-wysiwyg");
        editors.forEach(observeEditor);
        if (editors.length === 0) {
          setTimeout(tryBind, 800);
          return;
        }
        const bodyObs = new MutationObserver((mutations) => {
          for (const m of mutations) {
            m.addedNodes.forEach((n) => {
              if (n.nodeType !== 1) return;
              if (n.matches && n.matches(".protyle-wysiwyg")) {
                observeEditor(n);
              } else if (n.querySelectorAll) {
                n.querySelectorAll(".protyle-wysiwyg").forEach(observeEditor);
              }
            });
          }
        });
        bodyObs.observe(document.body, { childList: true, subtree: true });
        this._observers.push(bodyObs);
      };

      tryBind();
    }

    /* ===================== 手动扫描 ===================== */

    /* 扫描当前打开文档中「记录范围内」的段落并打标 */
    async scanAndTag() {
      const allParas = Array.from(
        document.querySelectorAll(
          '.protyle-wysiwyg [data-type="NodeParagraph"]'
        )
      );
      if (allParas.length === 0) {
        showMessage(`${NAME}：未检测到打开的文档`);
        return;
      }
      /* 脑图范围里的段落不扫：扫描要写块属性，写到脑图节点的块上会让思源
         判定「内容已更新，请重新编辑」（原因见 _isInListMindmap） */
      const paragraphs = allParas.filter((p) => !this._isInListMindmap(p));
      if (paragraphs.length === 0) {
        showMessage(`${NAME}：当前文档的列表以思维导图显示，请先切回列表再扫描`);
        return;
      }

      const docIds = new Set();
      paragraphs.forEach((p) => {
        const docId = this._docIdOf(p);
        if (this._validId(docId)) docIds.add(docId);
      });

      let scopedDocs = 0;
      for (const docId of docIds) {
        const meta = await this._docMetaOf(docId);
        if (this._inScope(meta)) scopedDocs++;
      }
      if (scopedDocs === 0) {
        showMessage(`${NAME}：${this._scopeMissHint()}`);
        return;
      }

      let tagged = 0;
      let unchanged = 0;
      let failed = 0;
      for (const p of paragraphs) {
        const docId = this._docIdOf(p);
        if (!this._validId(docId)) continue;
        const meta = await this._docMetaOf(docId);
        if (!this._inScope(meta)) continue;
        const info = parseLine(p.textContent || "");
        if (!info) continue;
        this._applyMark(p);
        try {
          const state = await this._serial(docId, () =>
            this._tagBlock(p.getAttribute("data-node-id"), info, meta.date)
          );
          if (state === "tagged") tagged++;
          else if (state === "unchanged") unchanged++;
          else failed++;
        } catch (e) {
          failed++;
        }
      }
      /* 有新增或更新就顺带把 Dock 与日历刷一遍，省得用户再手点一次刷新 */
      if (tagged > 0) this._notifyRecordsChanged();
      const total = tagged + unchanged + failed;
      const summary =
        total === 0
          ? `轻迹：记录范围内未发现符合「时间 类型：内容」的记录`
          : `轻迹：处理 ${total} 条记录，新增 ${tagged} 条，已最新 ${unchanged} 条` +
            (failed > 0 ? `，失败 ${failed} 条` : "");
      showMessage(summary);
    }

  };
})();
