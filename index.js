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

  /* 日历标签页里已经接了视图的段位。五个都接上了 ——
     以后再加段位，不在这里的点了只切高亮、不换内容。 */
  const CAL_TAB_VIEWS = ["month", "week", "three", "day", "stats"];

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
  const CAL_DOCS_LIMIT = 2000;

  /* ---- 时间轴视图（周 / 三日 / 日）尺寸 ----
     HOUR 是一小时的基准像素高度：小时高是「弹性」的 —— 记录密集的小时会被
     _calTimelineLayout 撑高，稀疏小时维持这个值；最终整天总高由 JS 内联写成
     CSS 变量 --tt-wv-total 传给样式表，这里就是基准的唯一来源。
     MIN_BLOCK 是块的最小高度，避免极短的活动被压成一条看不见的线。
     SHOW_TIME 是「放得下两行」的高度门槛 —— 低于它就改成标题与时间同一行，
     硬塞两行会被裁掉半行，比挤一行更难看。
     DEFAULT_MIN 给当天最后一条用：它没有下一条可参照，只能按默认时长摆一块。 */
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

  /* 下划线线宽：默认 0.75px，可在插件设置「控制设置 / 下划线粗细」中调整 */
  const DEFAULT_MARK_LINE_WIDTH = 0.75;
  const MARK_LINE_OPTIONS = [0.5, 0.75, 1, 1.5, 2].map((w) => ({
    value: String(w),
    label: `${w}px`,
  }));

  /* 规范化线宽：只接受候选档位，其余一律回退默认值 */
  const normLineWidth = (value) => {
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
     决定 Dock 时间线里每条记录的区间与「持续」怎么算：
     end   —— 结束模式（默认）：节点时间为结束时间，时长从同日上一条结束算到当前结束；
     start —— 开始模式：节点时间为开始时间，时长从当前开始算到下一条开始，
              下一条在次日时按天拆分（当天算到 24:00，余下一段挂到次日开头）。 */
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
      /* 同理回收「设置」弹窗（同样挂在 body 上） */
      if (this._settingsModal) {
        this._settingsModal.remove();
        this._settingsModal = null;
      }
      /* 把攒着没写的类型改动补一次落盘 */
      this._flushTypes();
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
        </div>
      `;
      const insertCard = container.querySelector('[data-tt-group="insert"]');
      const appearanceCard = container.querySelector('[data-tt-group="appearance"]');
      const calendarCard = container.querySelector('[data-tt-group="calendar"]');
      const controlCard = container.querySelector('[data-tt-group="control"]');

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
            "结束模式（默认）：节点时间为结束时间，时长从上一条结束算到当前结束。\n开始模式：节点时间为开始时间，时长从当前开始算到下一条开始。跨天时自动按天拆分。",
          controlType: "select",
          options: TIME_MODE_OPTIONS,
          value: this._timeCalcMode(),
          onChange: (v) => {
            const mode = normTimeMode(v);
            if (this.data.timeCalcMode === mode) return;
            this.data.timeCalcMode = mode;
            this._persist("保存时间计算模式");
            /* 区间与「持续」在渲染时现算：用缓存里的记录直接重绘即可 */
            this._refreshLifeLogDockContent();
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

      /* 挂载时拉取笔记本列表（传 container 让刷新落在自己这一份上，
         设置面板在设置弹窗中复用（仅此一处）；各自刷新各自那份，不互相抢 this.notebookCddl） */
      this._refreshNotebooks(container);
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

    /* 打开「设置」弹窗：把侧边栏 Dock 里的设置视图抽出来，做成截图那种
       「左侧导航 + 右侧内容」的原生设置版式（对齐思源设置弹窗的版式）。
       内容直接复用 _mountSettingsPanel()：它按 4 个分组构建 .tt-settings，
       这里按分组只显示其中一组；搜索时跨分组过滤行。

       层级刻意比类型管理弹窗（.tt-modal，9999）低 —— 设置里的「类型管理」
       按钮会在这个弹窗之上再开一层，不能被盖住。 */
    _openSettingsModal() {
      /* 同时只允许一个实例 */
      if (this._settingsModal) {
        this._settingsModal.remove();
        this._settingsModal = null;
      }
      /* 左侧导航 = 右侧那四个分组本身，点某一项只显示该分组。
         key 必须与 _mountSettingsPanel 里 .tt-group__card 的 data-tt-group
         取值一一对应（insert / appearance / calendar / control），
         对应关系是反查出来的，不依赖分组在 DOM 里的先后顺序。
         icon 一律用思源自带的图标 id（清单见 appearance/icons/<主题>/icon.js），
         写错 id 会渲染成一个空框。 */
      const GROUPS = [
        { key: "insert", label: "插入设置", icon: "iconEdit" },
        { key: "appearance", label: "视图外观", icon: "iconEye" },
        { key: "calendar", label: "日历设置", icon: "iconCalendar" },
        { key: "control", label: "控制设置", icon: "iconSettings" },
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
      let activeKey = GROUPS[0].key;

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
      for (const g of this.data.typeGroups || []) {
        const hit = (g.items || []).find(
          (i) => i.name === type && typeof i.color === "string" && i.color
        );
        if (hit) return hit.color;
      }
      return DEFAULT_TYPE_COLOR;
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

      /* 让 input 宽度跟随文字长度，避免空白过长 */
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
      this.saveData(DATA_KEY, Object.assign({}, this.data, { typeGroups: groups })).catch((e) =>
        console.warn(`${NAME}：${tag}失败`, e)
      );
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

    /* 查询当前前缀的打标记录（最近 200 条）
       前缀已在 normAttrPrefix 中白名单过滤，仅含小写字母、数字与连字符。 */
    async _queryLifeLogDockRecords() {
      const records = [];
      try {
        const aDate = this._attr("date");
        const aTime = this._attr("time");
        const aType = this._attr("type");
        const aContent = this._attr("content");
        const sql = `SELECT b.id, b.content,
                            a1.value AS tt_date,
                            a2.value AS tt_time,
                            a3.value AS tt_type,
                            a4.value AS tt_content
                     FROM blocks b
                     INNER JOIN attributes a1 ON b.id = a1.block_id AND a1.name = '${aDate}'
                     INNER JOIN attributes a2 ON b.id = a2.block_id AND a2.name = '${aTime}'
                     INNER JOIN attributes a3 ON b.id = a3.block_id AND a3.name = '${aType}'
                     INNER JOIN attributes a4 ON b.id = a4.block_id AND a4.name = '${aContent}'
                     WHERE b.type = 'p'
                     ORDER BY a1.value DESC, a2.value DESC, b.id
                     LIMIT 200`;
        const resp = await this._request("/api/query/sql", { stmt: sql });
        if (resp.code !== 0 || !Array.isArray(resp.data)) return records;
        for (const row of resp.data) {
          records.push({
            id: `lifelog_dock_${row.id}`,
            content: (row.tt_content || row.content || "").trim(),
            date: (row.tt_date || "").trim().replace(/\//g, "-"),
            time: (row.tt_time || "").trim(),
            type: (row.tt_type || "").trim(),
          });
        }
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
    _calTabTypeOptions() {
      const count = new Map();
      (this._calSourceRecords() || []).forEach((r) => {
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
      if (view === "week") return before ? "上一周" : "下一周";
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
    /* 按类型累计「时长(分钟)」与「条数」。时长规则与日历时间轴一致：
       同一天里从本条记到下一条开始，显式区间优先，
       当天最后一条补默认 30 分钟，不跨天；时间解析不出的记录不计。 */
    _statsTypeDurations(records) {
      const minutes = new Map();
      const counts = new Map();
      const byDay = new Map();
      (records || []).forEach((r) => {
        if (!r || !r.date) return;
        const range = this._parseTimeRange(r.time);
        if (!range) return;
        if (!byDay.has(r.date)) byDay.set(r.date, []);
        byDay
          .get(r.date)
          .push({ type: (r.type || "").trim(), start: range.start, end: range.end });
      });
      byDay.forEach((list) => {
        list.sort((a, b) => a.start - b.start);
        list.forEach((x, i) => {
          const next = list[i + 1];
          let endMin =
            x.end !== null ? x.end : next ? next.start : x.start + WEEK_DEFAULT_MIN;
          if (endMin <= x.start) endMin = x.start + 1;
          if (!x.type) return;
          minutes.set(x.type, (minutes.get(x.type) || 0) + (endMin - x.start));
          counts.set(x.type, (counts.get(x.type) || 0) + 1);
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

      /* ==================== 类型分布：胶囊芯片网格 ====================
         一枚芯片 = 色点 + 类型名 + 记录条数，一行数枚自动换行；
         纯展示不可点，悬停气泡显示该类型的累计用时。 */
      const typeChipsHtml = typeRows
        .map((t) => {
          return `<div class="north-caltab-stats-chip" data-tip="${escapeHtml(
            `${t.name} · 用时 ${this._fmtStatsDur(t.min)}`
          )}">
                <i class="north-caltab-stats-chip-dot" style="background:${t.color}"></i>
                <span class="north-caltab-stats-chip-name">${escapeHtml(t.name)}</span>
                <span class="north-caltab-stats-chip-val">${t.cnt} ${unit}</span>
            </div>`;
        })
        .join("");
      const typesBody = typeRows.length
        ? `<div class="north-caltab-stats-chips">${typeChipsHtml}</div>`
        : `<div class="north-caltab-stats-empty">这一段还没有带类型的记录</div>`;

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
            ${section("类型分布", `${typeRows.length} 个类型`, typesBody)}
        </div>`;
    }
    /* 时间轴视图（周 / 三日 / 日）摆块的三步走：
       ① _parseCalTimelineRecords —— 解析并按开始时间排序；
       ② _calTimelineLayout —— 按各天记录估出「弹性小时高」：本插件偏记录，
          密集时段几分钟一条，块又保底 22px 高，固定 40px/小时必然叠字。
          哪个小时装不下就把那个小时撑高（全部列共享一套小时高，刻度列的
          标签才始终对得上线）；空旷时段维持 40px，看起来与普通日历无异。
       ③ _buildCalendarTimelineEvents —— 块按时间比例定位，但与上一块
          贴上时只后退到刚好不叠的位置：拥挤的记录上下排开，永不互相压字。 */

    /* 解析一天的记录为 {record, range} 并按开始时间升序，时间非法的丢弃 */
    _parseCalTimelineRecords(records) {
      return (records || [])
        .map((r) => ({ record: r, range: this._parseTimeRange(r.time) }))
        .filter((x) => x.range)
        .sort((a, b) => a.range.start - b.range.start);
    }

    /* 第 i 条记录的结束分钟：显式区间 > 下一条开始 > 默认 30 分钟。
       结束不晚于开始时补 1 分钟，保证块至少有个高度可算。 */
    _calTimelineEndMin(parsed, i) {
      const x = parsed[i];
      const next = parsed[i + 1];
      const explicitEnd = x.range.end;
      const nextStart = next ? next.range.start : null;
      let end =
        explicitEnd !== null
          ? explicitEnd
          : nextStart !== null
          ? nextStart
          : x.range.start + WEEK_DEFAULT_MIN;
      if (end <= x.range.start) end = x.range.start + 1;
      return { end, explicitEnd, nextStart };
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
        parsed.forEach((x, i) => {
          const { end } = this._calTimelineEndMin(parsed, i);
          const top = Math.max(
            (x.range.start / 60) * WEEK_HOUR_H,
            prevBottom + WEEK_EVENT_GAP
          );
          const bottom =
            top +
            Math.max(
              WEEK_MIN_BLOCK_H,
              ((end - x.range.start) / 60) * WEEK_HOUR_H
            );
          prevBottom = bottom;
          const hb = Math.max(
            0,
            Math.min(23, Math.floor((bottom - 0.01) / WEEK_HOUR_H))
          );
          need[hb] = Math.max(need[hb], bottom - hb * WEEK_HOUR_H);
          const h = Math.floor(x.range.start / 60);
          if (!byHour.has(h)) byHour.set(h, []);
          byHour.get(h).push(x.range.start);
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
       块高固定取到「下一条记录」为止（这是摆块的几何规则，不随「时间计算模式」变 ——
       Dock 时间线的「持续」才跟模式走），当天最后一条没有下一条可参照，
       就只显示起始时间、给一个最小高度（那段时间本来就没有数据）。
       top / height 在 JS 里算好写进 style：高度还得反过来决定时间行怎么摆，
       这件事 CSS 做不到（矮块里的两行会被裁掉半行）。 */
    _buildCalendarTimelineEvents(parsed, layout) {
      const yOf = layout.yOf;
      /* 顺序摆 + 最小间距：上一块的块底就是下一块的近端下限，
         挤在一起的记录（如 12:39 / 12:40 各一条）依次往下排，不再叠字 */
      let prevBottom = -WEEK_EVENT_GAP;
      return parsed.map((x, i) => {
        const { end, explicitEnd, nextStart } = this._calTimelineEndMin(parsed, i);
        /* 只有「有真实来源」且结束确实晚于开始时才表述成区间；
           否则只显示起始时间，不编一个结束时间出来 */
        const showRange =
          end > x.range.start && (explicitEnd !== null || nextStart !== null);

        const top = Math.max(yOf(x.range.start), prevBottom + WEEK_EVENT_GAP);
        const height = Math.max(
          WEEK_MIN_BLOCK_H,
          yOf(end) - yOf(x.range.start)
        );
        prevBottom = top + height;

        /* 块够高就上下两行：标题一行、完整区间一行。
           不够高（当天末条基本都是这种）就压成一行，时间只写起始 ——
           宁可少写个结束时间，也不能让起始时间整个看不见。
           一行时把时间放在标题**前面**：时间短且固定，放前面保证不会被裁掉，
           要裁就裁标题，反正完整记录还挂在悬停气泡上。 */
        const compact = height < WEEK_SHOWTIME_H;
        const label =
          !compact && showRange
            ? `${this._fmtMin(x.range.start)} - ${this._fmtMin(end)}`
            : this._fmtMin(x.range.start);

        const r = x.record;
        const c = this._calRecordColor(r);
        const hint = this._iconHint(r);
        const tip = `${r.time || ""} ${r.type || ""}：${this._brToSpace(r.content)}${hint ? ` (${hint})` : ""}`.trim();
        const style = `top:${top.toFixed(1)}px;height:${height.toFixed(1)}px${
          c ? `;--tt-c:${c}` : ""
        }`;
        const timeSpan = `<span class="north-caltab-wv-event-time">${escapeHtml(
          label
        )}</span>`;
        const titleSpan = `<span class="north-caltab-wv-event-title">${escapeHtml(
          r.content || ""
        )}</span>`;
        return `<div class="north-caltab-wv-event${
          compact ? " is-compact" : ""
        }" style="${style}" data-cal-id="${escapeHtml(r.id || "")}" data-tip="${escapeHtml(
          tip
        )}">${compact ? timeSpan + titleSpan : titleSpan + timeSpan}</div>`;
      });
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
      /* 时间轴视图 = 周 / 三日，两者共用同一套结构与尺寸，只有列数不同 */
      const isTimeline = view === "week" || view === "three" || view === "day";
      const isStats = view === "stats";
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

      /* 标题：月视图给年月，时间轴视图给这一段的起止日期，统计视图给周期起止 */
      let title = `${monthAnchor.getFullYear()}年${monthAnchor.getMonth() + 1}月`;
      if (isStats) {
        title = this._computeLifeLogDockPeriod(
          this._calTabStatsPeriod,
          this._calTabStatsAnchor
        ).label;
      }

      /* 月视图才需要算三个月的格子（126 格，每格都要算农历 / 节气），
         时间轴视图下这活儿纯属白干，所以放进分支里 */
      let body = "";
      if (isStats) {
        body = this._buildCalendarStatsHtml();
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
          this._calTabTypeOptions().map(
            (o) =>
              `<div class="north-caltab-typeopt${
                this._calTabTypeFilter.has(o.name) ? " on" : ""
              }" data-cal-type="${escapeHtml(o.name)}">` +
              `<span class="north-caltab-typedot" style="background:${o.color}"></span>` +
              `<span>${escapeHtml(o.name)}</span></div>`
          )
        )
        .join("");

      container.innerHTML = `
            <div class="north-caltab-bar">
                <span class="north-caltab-title">${title}</span>
                <div class="north-caltab-segments">
                    ${seg("month", "月")}
                    ${seg("week", "周")}
                    ${seg("three", "三")}
                    ${seg("day", "日")}
                    ${seg("stats", "统计")}
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
      /* 点面板外收起筛选面板。挂文档级、只挂一份，卸载时摘掉。
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
            this._openSettingsModal();
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
        if (!text) return;
        clearTimeout(timer);
        /* 轻微延迟：快速划过一排日期格时不会连闪 */
        timer = setTimeout(() => {
          tip.textContent = text;
          tip.classList.add("is-visible");
          this._placeTooltip(tip, target);
        }, 90);
      };

      root.addEventListener("mouseover", (e) => {
        const target = e.target.closest && e.target.closest("[data-tip]");
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
        const target = e.target.closest && e.target.closest("[data-tip]");
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

    _clearMark(p) {
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
      p.classList.remove("tt-nomark");
      p.classList.add("tt-hit");
    }

    /* 当前生效的下划线线宽（px），默认 0.75 */
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
      const rules = [
        /* 线宽、线色与底色由设置里的「下划线粗细」「记录底色」决定；
           底色档位为 0（关闭）时输出 transparent，等价于不上底色，底边线不受影响。
           选择器同时覆盖两种情况：
           1) .tt-hit —— JS 即时打标，用于「刚输入、块属性还没写进库」的那一瞬间；
           2) 带记录类型属性的段落 —— 思源渲染文档时属性就已经在 DOM 上了，
              靠它让下划线与文字同时出现，不必等异步扫描补标
              （否则刷新后会先有文字、过一会儿才浮出下划线）。
           范围外的段落由 JS 挂 .tt-nomark 压掉；属性本身不删，数据不丢。 */
        [
          `.protyle-wysiwyg [data-type="NodeParagraph"].tt-hit,`,
          `.protyle-wysiwyg [data-type="NodeParagraph"][${attr}]:not(.tt-nomark) {`,
          `  --tt-line-w: ${this._lineWidth()}px;`,
          `  --tt-line: color-mix(in srgb, var(--tt-c, ${DEFAULT_TYPE_COLOR}) ${MARK_LINE_MIX}%, transparent);`,
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
      const paragraphs = Array.from(
        document.querySelectorAll(
          '.protyle-wysiwyg [data-type="NodeParagraph"]'
        )
      );
      if (paragraphs.length === 0) {
        showMessage(`${NAME}：未检测到打开的文档`);
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
