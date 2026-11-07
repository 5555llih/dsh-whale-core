/**
 * dsh-whale-core —— 浏览器半边（手写的 __ModuleLoader__ bundle，无构建工具）
 *
 * 设置页里的一页「鲸核」，五个页签：
 *   内核（人设）/ 心情 / 记忆（权重 + 召回）/ 日记（间隔 + 复盘）/ 状态
 *
 * 约定（踩过坑）：
 *   · __ModuleLoader__.load 的 id 必须是【包名】dsh-whale-core；宿主按包名建 loader 行，
 *     注册 id 对不上会让脚本跑两遍 → duplicate factory registration → 启动崩溃。
 *   · 工厂只拿 require，返回什么就是 exports（不注入 module/exports）。
 *   · 深色主题下原生 select 弹出层是系统白底，浅字看不清 —— 这里不用 select，
 *     枚举一律按钮组，输入类控件走 color-scheme + 半透明底。
 */
window.__ModuleLoader__.load({
  id: 'dsh-whale-core',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback

    var API = '/whale-core/api'
    var TAB_KEY = 'dsh-whale-core:tab'

    // 八个心情，跟宿主 EMO_LIST 一一对应
    var EMO_LIST = ['高兴', '喜欢', '平静', '难过', '生气', '害怕', '寂寞', '厌恶']
    var EMO_HINT = {
      高兴: '话多、活泼',
      喜欢: '黏人、撒娇',
      平静: '正常节奏',
      难过: '话少、示弱',
      生气: '话短、带刺',
      害怕: '谨慎、退让',
      寂寞: '主动找话题',
      厌恶: '敷衍、拉开距离',
    }
    var STAGE_HINT = {
      厌恶: '0-15 冷、句子短',
      冷漠: '16-35 公事公办',
      平常: '36-60 正常聊天',
      关心: '61-80 主动搭把手',
      喜爱: '81-100 护短、吃醋',
    }

    var TABS = [
      { id: 'kernel', label: '内核' },
      { id: 'mood', label: '心情' },
      { id: 'memory', label: '记忆' },
      { id: 'diary', label: '日记' },
      { id: 'status', label: '状态' },
    ]

    var DIARY_PRESETS = [60, 180, 360, 720, 1440]

    var CSS = [
      '[data-wk],[data-wk] *{box-sizing:border-box;}',
      '[data-wk]{display:flex;flex-direction:column;gap:12px;font-size:13px;color:inherit;color-scheme:light dark;}',
      '[data-wk-head]{display:flex;align-items:center;gap:9px;flex-wrap:wrap;}',
      '[data-wk-dot]{width:8px;height:8px;border-radius:50%;background:#3ecf8e;box-shadow:0 0 0 3px rgba(62,207,142,.16);flex:0 0 auto;}',
      '[data-wk-dot="off"]{background:#9a9a9a;box-shadow:0 0 0 3px rgba(154,154,154,.14);}',
      '[data-wk-name]{font-weight:600;font-size:13.5px;letter-spacing:.2px;}',
      '[data-wk-sub]{font-size:11.5px;opacity:.5;}',
      '[data-wk-spacer]{flex:1 1 auto;}',
      '[data-wk-tabs]{display:flex;gap:4px;flex-wrap:wrap;padding-bottom:8px;border-bottom:1px solid rgba(127,127,127,.18);}',
      '[data-wk-tab]{padding:5px 12px;border-radius:8px;border:1px solid transparent;background:transparent;color:inherit;font-size:12.5px;cursor:pointer;opacity:.68;font-family:inherit;}',
      '[data-wk-tab]:hover{background:rgba(127,127,127,.1);opacity:1;}',
      '[data-wk-tab][data-on]{background:rgba(127,127,127,.15);border-color:rgba(127,127,127,.26);opacity:1;font-weight:600;}',
      '[data-wk-pane]{display:flex;flex-direction:column;gap:12px;}',
      '[data-wk-card]{border:1px solid rgba(127,127,127,.16);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:9px;}',
      '[data-wk-label]{font-size:12px;font-weight:600;opacity:.78;display:flex;align-items:center;gap:7px;flex-wrap:wrap;}',
      '[data-wk-hint]{font-size:11.5px;line-height:1.65;opacity:.55;}',
      '[data-wk-row]{display:flex;align-items:center;gap:9px;flex-wrap:wrap;}',
      '[data-wk-textarea]{width:100%;min-height:160px;resize:vertical;border-radius:9px;border:1px solid rgba(127,127,127,.26);background:rgba(127,127,127,.07);color:inherit;font:inherit;line-height:1.7;padding:10px 12px;}',
      '[data-wk-input]{flex:1 1 160px;min-width:0;border-radius:9px;border:1px solid rgba(127,127,127,.26);background:rgba(127,127,127,.07);color:inherit;font:inherit;padding:8px 11px;}',
      '[data-wk-input][data-wk-name]{flex:0 0 auto;width:148px;padding:4px 9px;font-size:12.5px;line-height:1.5;}',
      '[data-wk-num-in]{width:74px;border-radius:9px;border:1px solid rgba(127,127,127,.26);background:rgba(127,127,127,.07);color:inherit;font:inherit;padding:7px 9px;text-align:right;font-variant-numeric:tabular-nums;}',
      '[data-wk-note]{font-size:11.5px;opacity:.55;white-space:nowrap;}',
      '[data-wk-quote]{margin:8px 0 0;padding:9px 11px;border-radius:9px;border-left:3px solid rgba(127,127,127,.5);background:rgba(127,127,127,.07);font-size:13px;line-height:1.7;word-break:break-word;}',
      '[data-wk-pre]{margin:0;padding:12px;border-radius:9px;border:1px dashed rgba(127,127,127,.3);background:rgba(127,127,127,.05);white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.7;max-height:320px;overflow:auto;}',
      '[data-wk-textarea]:focus,[data-wk-input]:focus,[data-wk-num-in]:focus{outline:2px solid rgba(75,123,236,.55);outline-offset:-1px;}',
      '[data-wk-btn]{border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;border-radius:8px;padding:6px 13px;font:inherit;font-size:12.5px;cursor:pointer;}',
      '[data-wk-btn]:hover{background:rgba(127,127,127,.1);}',
      '[data-wk-btn][data-primary]{background:rgba(75,123,236,.9);border-color:transparent;color:#fff;}',
      '[data-wk-btn][data-primary]:hover{background:rgba(75,123,236,1);}',
      '[data-wk-btn][data-mini]{padding:3px 9px;font-size:11.5px;}',
      '[data-wk-btn][disabled]{opacity:.45;cursor:default;}',
      '[data-wk-switch]{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;}',
      '[data-wk-switch] input{width:15px;height:15px;accent-color:#4b7bec;cursor:pointer;}',
      '[data-wk-chips]{display:flex;gap:7px;flex-wrap:wrap;}',
      '[data-wk-chip]{display:flex;flex-direction:column;gap:2px;align-items:flex-start;padding:7px 12px;border-radius:10px;border:1px solid rgba(127,127,127,.24);background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left;}',
      '[data-wk-chip]:hover{background:rgba(127,127,127,.08);}',
      '[data-wk-chip][data-on]{border-color:rgba(75,123,236,.7);background:rgba(75,123,236,.14);}',
      '[data-wk-chip] i{font-style:normal;font-size:12.5px;font-weight:600;}',
      '[data-wk-chip] em{font-style:normal;font-size:10.5px;opacity:.55;}',
      '[data-wk-seg]{display:flex;gap:0;border:1px solid rgba(127,127,127,.26);border-radius:8px;overflow:hidden;}',
      '[data-wk-seg] button{border:0;background:transparent;color:inherit;font:inherit;font-size:12px;padding:5px 12px;cursor:pointer;opacity:.7;}',
      '[data-wk-seg] button+button{border-left:1px solid rgba(127,127,127,.2);}',
      '[data-wk-seg] button[data-on]{background:rgba(75,123,236,.2);opacity:1;font-weight:600;}',
      '[data-wk-meter]{position:relative;flex:1 1 150px;min-width:110px;height:8px;border-radius:5px;background:rgba(127,127,127,.18);overflow:hidden;}',
      '[data-wk-meter] > i{display:block;height:100%;border-radius:5px;background:linear-gradient(90deg,#4b7bec,#35d6c9);transition:width .25s;}',
      '[data-wk-range]{flex:0 1 150px;min-width:110px;accent-color:#4b7bec;}',
      '[data-wk-num]{font-variant-numeric:tabular-nums;font-size:12px;opacity:.75;min-width:42px;text-align:right;}',
      '[data-wk-list]{display:flex;flex-direction:column;gap:6px;max-height:340px;overflow:auto;}',
      '[data-wk-item]{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:9px;background:rgba(127,127,127,.06);font-size:12px;line-height:1.6;}',
      '[data-wk-item] [data-text]{flex:1 1 auto;word-break:break-word;}',
      '[data-wk-item] time{font-size:11px;opacity:.42;white-space:nowrap;font-variant-numeric:tabular-nums;}',
      '[data-wk-tag]{font-size:10px;padding:1px 5px;border-radius:5px;border:1px solid rgba(127,127,127,.35);opacity:.65;flex:0 0 auto;}',
      '[data-wk-tag="fact"]{color:#4b8bec;border-color:rgba(75,139,236,.5);}',
      '[data-wk-tag="review"]{color:#c08b3e;border-color:rgba(192,139,62,.5);}',
      '[data-wk-tag="tier1"]{color:#d08b2a;border-color:rgba(208,139,42,.55);opacity:.9;}',
      '[data-wk-tag="tier2"]{opacity:.58;}',
      '[data-wk-tag="tier3"]{opacity:.38;border-style:dashed;}',
      '[data-wk-kv]{display:grid;grid-template-columns:auto 1fr;gap:7px 16px;font-size:12px;line-height:1.5;}',
      '[data-wk-kv] b{font-weight:500;opacity:.5;white-space:nowrap;}',
      '[data-wk-kv] span{word-break:break-all;font-variant-numeric:tabular-nums;}',
      '[data-wk-ok]{font-size:11.5px;color:#2f9e6b;}',
      '[data-wk-err]{font-size:11.5px;color:#e05a4f;word-break:break-word;}',
      '[data-wk-mono]{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;opacity:.72;word-break:break-all;}',
      '[data-wk-empty]{font-size:12px;opacity:.45;padding:6px 2px;}',
      '[data-wk-say]{font-size:12px;line-height:1.7;white-space:pre-wrap;opacity:.85;padding:8px 10px;border-radius:9px;background:rgba(127,127,127,.06);}',
    ].join('')

    /* ── 网络 ─────────────────────────────────────────────── */
    // 带上超时与状态检查：以前 fetch 不判 r.ok、也没超时，一个卡住的请求就能让面板一直转圈
    function request(url, opts) {
      var ms = 15000
      var ctl = typeof AbortController === 'function' ? new AbortController() : null
      var timer = setTimeout(function () {
        if (ctl) ctl.abort()
      }, ms)
      var o = { credentials: 'same-origin' }
      var k
      for (k in opts || {}) o[k] = opts[k]
      if (ctl) o.signal = ctl.signal
      return fetch(url, o).then(
        function (r) {
          clearTimeout(timer)
          return r.text().then(function (t) {
            var d = null
            try {
              d = t ? JSON.parse(t) : null
            } catch (e) {
              throw new Error(r.ok ? '返回的不是 JSON' : String(t || 'HTTP ' + r.status).slice(0, 160))
            }
            if (!r.ok) throw new Error((d && d.error) || 'HTTP ' + r.status)
            return d
          })
        },
        function (e) {
          clearTimeout(timer)
          throw new Error(e && e.name === 'AbortError' ? '请求超时（15 秒）' : String((e && e.message) || e))
        },
      )
    }
    function getJson(url) {
      return request(url, { headers: { accept: 'application/json' } })
    }
    function postJson(url, body) {
      return request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
    }
    function pct(v) {
      return Math.round((Number(v) || 0) * 100)
    }
    function when(t) {
      if (!t) return '还没'
      var d = new Date(Number(t))
      var now = new Date()
      var hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
      if (d.toDateString() === now.toDateString()) return hm
      return String(d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm
    }
    // 骰子那一行：说清这次是怎么来的（定时 / 反应 / 手动），以及之后心情有没有被改过
    function diceHint(dice, mood) {
      if (!dice || !dice.lastEmotion) return '还没掷过'
      var at = dice.lastRollAt || dice.lastAt
      var kind =
        dice.lastKind === 'reaction' ? '反应' : dice.lastKind === 'manual' ? '手动' : dice.lastKind === 'timer' ? '定时' : ''
      var over = Boolean(
        at && mood && mood.updatedAt && mood.updatedAt > at + 1000 && mood.emotion && mood.emotion !== dice.lastEmotion,
      )
      return (
        '上次：' +
        dice.lastEmotion +
        (kind ? ' · ' + kind : '') +
        (dice.lastRoll ? ' · 点数 ' + dice.lastRoll : '') +
        (at ? ' · ' + when(at) : '') +
        (over ? '（之后改成了' + mood.emotion + '）' : '')
      )
    }
    function inMinutes(t) {
      if (!t) return '—'
      var mins = Math.round((Number(t) - Date.now()) / 60000)
      if (mins <= 0) return '马上'
      if (mins < 60) return mins + ' 分钟后'
      if (mins < 1440) return Math.round(mins / 60) + ' 小时后'
      return Math.round(mins / 1440) + ' 天后'
    }
    function perMin(n) {
      var v = Number(n) || 0
      if (v < 60) return v + ' 分钟'
      if (v < 1440) return (v / 60).toFixed(v % 60 ? 1 : 0) + ' 小时'
      return (v / 1440).toFixed(v % 1440 ? 1 : 0) + ' 天'
    }
    function moodOf(list, label) {
      for (var i = 0; i < list.length; i++) if (list[i].id === label) return list[i]
      return { id: label || '平静', energy: 0.6, hint: '' }
    }

    /* ── 小控件 ───────────────────────────────────────────── */
    function Slider(p) {
      return h(
        'div',
        { 'data-wk-row': '' },
        h('span', { 'data-wk-hint': '', style: { minWidth: p.width || 56 } }, p.label),
        h('input', {
          'data-wk-range': '',
          type: 'range',
          min: '0',
          max: '100',
          step: '1',
          value: p.value,
          disabled: p.disabled,
          onChange: function (e) {
            p.onChange(Number(e.target.value))
          },
          onPointerUp: function (e) {
            if (p.onCommit) p.onCommit(Number(e.target.value))
          },
          onKeyUp: function (e) {
            if (p.onCommit) p.onCommit(Number(e.target.value))
          },
        }),
        h('span', { 'data-wk-num': '' }, p.value + '%'),
      )
    }

    function Toggle(p) {
      return h(
        'label',
        { 'data-wk-switch': '' },
        h('input', {
          type: 'checkbox',
          checked: Boolean(p.checked),
          disabled: p.disabled,
          onChange: function (e) {
            p.onChange(e.target.checked)
          },
        }),
        h('span', null, p.label),
      )
    }

    function Seg(p) {
      return h(
        'div',
        { 'data-wk-seg': '' },
        p.options.map(function (o) {
          return h(
            'button',
            {
              key: o.id,
              'data-on': p.value === o.id ? '' : undefined,
              disabled: p.disabled,
              onClick: function () {
                p.onChange(o.id)
              },
            },
            o.label,
          )
        }),
      )
    }

    /* ── 页签一：内核 ─────────────────────────────────────── */
    function KernelPane(s) {
      var sections = s.sections || []
      var on = sections.filter(function (x) {
        return x.enabled !== false && String(x.text || '').trim()
      })
      var preview = on
        .map(function (x) {
          return '## ' + x.label + '\n' + String(x.text || '').trim()
        })
        .join('\n\n')
      return h(
        'div',
        { 'data-wk-pane': '' },
        h(
          'div',
          { 'data-wk-card': '' },
          h(
            'div',
            { 'data-wk-row': '' },
            h(Toggle, {
              checked: s.enabled,
              disabled: s.busy,
              label: '启用鲸核',
              onChange: function (v) {
                s.save({ enabled: v }, v ? '已启用' : '已关闭')
              },
            }),
            h('span', { 'data-wk-spacer': '' }),
            h('span', { 'data-wk-hint': '' }, s.enabled ? '人设、心情、记忆都在注入' : '全关：连注释都不发了'),
          ),
          h('div', { 'data-wk-hint': '' }, '注入走 systemPrompt.context。人设在前当稳定前缀，记忆块垫在最后一行 —— 前面那截不受记忆变化影响，缓存才吃得满。'),
        ),
        h(
          'div',
          { 'data-wk-card': '' },
          h(
            'div',
            { 'data-wk-label': '' },
            '人设库',
            h('span', { 'data-wk-hint': '' }, (s.personas || []).length + 1 + ' 套 · 新会话默认「' + s.activeName + '」'),
          ),
          h(
            'div',
            { 'data-wk-hint': '' },
            '每套人设各有自己的一套板块，下面那张卡改的就是这里选中那套。新开的对话按「默认」走；想让某个对话单独换一套，用下面「会话绑定」那张卡，或者跟小鲸说一句（whale_persona）。',
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h(
              'button',
              {
                'data-wk-btn': '',
                'data-primary': s.editId ? undefined : '',
                disabled: s.busy,
                onClick: function () {
                  s.selectPersona('')
                },
              },
              s.kernelName + '（' + s.kernelChars + ' 字）',
            ),
            (s.personas || []).map(function (p) {
              return h(
                'button',
                {
                  key: p.id,
                  'data-wk-btn': '',
                  'data-primary': s.editId === p.id ? '' : undefined,
                  disabled: s.busy,
                  onClick: function () {
                    s.selectPersona(p.id)
                  },
                },
                p.name + (p.id === s.activeId ? ' · 默认' : ''),
              )
            }),
          ),
          h('div', { 'data-wk-hint': '' }, '下面那张卡里改的，就是这里选中的这套；改完要点「保存全部板块」。'),
          h(
            'div',
            { 'data-wk-row': '' },
            h(
              'button',
              {
                'data-wk-btn': '',
                disabled: s.busy || (s.personas || []).length >= 8,
                onClick: function () {
                  s.createPersona()
                },
              },
              '新建（复制这套）',
            ),
            h('input', {
              'data-wk-input': '',
              value: s.personaName,
              placeholder: '名字',
              'aria-label': '人设名',
              disabled: s.busy,
              onChange: function (e) {
                s.setPersonaName(e.target.value)
              },
              onKeyDown: function (e) {
                if (e.key === 'Enter') s.renamePersona()
              },
            }),
            h(
              'button',
              {
                'data-wk-btn': '',
                disabled: s.busy,
                onClick: function () {
                  s.renamePersona()
                },
              },
              '改名',
            ),
            h(
              'button',
              {
                'data-wk-btn': '',
                disabled: s.busy || !s.editId || s.editId === s.activeId,
                onClick: function () {
                  s.makeDefault()
                },
              },
              '设为新会话默认',
            ),
            h('span', { 'data-wk-spacer': '' }),
            h(
              'button',
              {
                'data-wk-btn': '',
                disabled: s.busy || !s.editId,
                onClick: function () {
                  s.deletePersona()
                },
              },
              s.delAsk ? '真的要删？' : '删除这套',
            ),
          ),
        ),
        // 会话绑定：一个对话一行，按钮组里挑这套人设（不用 select，深色下弹出层看不清）
        h(
          'div',
          { 'data-wk-card': '' },
          h(
            'div',
            { 'data-wk-label': '' },
            '会话绑定',
            h('span', { 'data-wk-hint': '' }, (s.sessions || []).length + ' 个对话 · 已绑 ' + s.boundSessions + ' 个' + (s.archivedCount ? ' · 归档 ' + s.archivedCount + ' 个（不列出）' : '')),
          ),
          h(
            'div',
            { 'data-wk-hint': '' },
            '点一个对话右边的人设，就是让「这个对话以后用它」。没绑的跟着新会话默认走；绑过的不因为换默认而变。',
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h(
              'button',
              {
                'data-wk-btn': '',
                disabled: s.busy,
                onClick: function () {
                  s.reloadSessions()
                },
              },
              '刷新列表',
            ),
            h('span', { 'data-wk-spacer': '' }),
            h('span', { 'data-wk-hint': '' }, '列最近 12 个对话，归档的不显示'),
          ),
          (s.sessions || []).map(function (row) {
            return h(
              'div',
              { key: row.sid, 'data-wk-row': '' },
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', minWidth: '170px' } },
                h('span', { 'data-wk-hint': '', title: row.sid }, row.title),
                h('span', { 'data-wk-hint': '' }, (row.cwd ? row.cwd + ' · ' : '') + row.ago),
              ),
              h('span', { 'data-wk-spacer': '' }),
              h(
                'button',
                {
                  'data-wk-btn': '',
                  'data-mini': '',
                  'data-primary': row.personaId ? undefined : '',
                  disabled: s.busy,
                  onClick: function () {
                    s.bindPersona(row.sid, '')
                  },
                },
                s.kernelName,
              ),
              (s.personas || []).map(function (p) {
                return h(
                  'button',
                  {
                    key: p.id,
                    'data-wk-btn': '',
                    'data-mini': '',
                    'data-primary': row.personaId === p.id ? '' : undefined,
                    disabled: s.busy,
                    onClick: function () {
                      s.bindPersona(row.sid, p.id)
                    },
                  },
                  p.name,
                )
              }),
            )
          }),
        ),
        h(
          'div',
          { 'data-wk-card': '' },
          h(
            'div',
            { 'data-wk-label': '' },
            '人设板块',
            h('span', { 'data-wk-hint': '' }, (s.editId ? s.personaName : '默认人设') + ' · ' + sections.length + ' 块 · 拼起来 ' + preview.length + ' 字'),
          ),
          h(
            'div',
            { 'data-wk-hint': '' },
            '一块写一件事：人设卡写她是谁，说话方式写怎么说，行为准则写怎么做。关掉的板块不会注入。',
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h(
              'button',
              {
                'data-wk-btn': '',
                'data-primary': '',
                disabled: s.busy,
                onClick: function () {
                  s.saveKernel()
                },
              },
              '保存全部板块',
            ),
            h(
              'button',
              {
                'data-wk-btn': '',
                disabled: s.busy || sections.length >= 20,
                onClick: function () {
                  s.addSection()
                },
              },
              '新增板块',
            ),
            h('span', { 'data-wk-spacer': '' }),
            h('span', { 'data-wk-hint': '' }, s.kernelDirty ? '有没保存的改动' : '和已保存的一致'),
          ),
        ),
        sections.length
          ? sections.map(function (sec, idx) {
              return h(
                'div',
                { key: sec.id, 'data-wk-card': '' },
                h(
                  'div',
                  { 'data-wk-row': '' },
                  h(Toggle, {
                    checked: sec.enabled !== false,
                    disabled: s.busy,
                    label: '',
                    onChange: function (v) {
                      s.toggleSection(sec.id, v)
                    },
                  }),
                  h('input', {
                    'data-wk-input': '',
                    'data-wk-name': '',
                    value: sec.label || '',
                    spellCheck: false,
                    placeholder: '板块名',
                    disabled: s.busy,
                    onChange: function (e) {
                      s.updateSection(sec.id, { label: e.target.value })
                    },
                  }),
                  h('span', { 'data-wk-spacer': '' }),
                  h('span', { 'data-wk-hint': '' }, String(sec.text || '').length + ' / 4000 字'),
                ),
                h('textarea', {
                  'data-wk-textarea': '',
                  value: sec.text || '',
                  spellCheck: false,
                  placeholder: '这一块写什么',
                  disabled: s.busy,
                  onChange: function (e) {
                    s.updateSection(sec.id, { text: e.target.value })
                  },
                }),
                h(
                  'div',
                  { 'data-wk-row': '' },
                  h(
                    'button',
                    {
                      'data-wk-btn': '',
                      disabled: s.busy || idx === 0,
                      onClick: function () {
                        s.moveSection(sec.id, -1)
                      },
                    },
                    '上移',
                  ),
                  h(
                    'button',
                    {
                      'data-wk-btn': '',
                      disabled: s.busy || idx === sections.length - 1,
                      onClick: function () {
                        s.moveSection(sec.id, 1)
                      },
                    },
                    '下移',
                  ),
                  h(
                    'button',
                    {
                      'data-wk-btn': '',
                      disabled: s.busy || sections.length <= 1,
                      onClick: function () {
                        s.removeSection(sec.id)
                      },
                    },
                    '删掉这块',
                  ),
                ),
              )
            })
          : h('div', { 'data-wk-empty': '' }, '还没有板块，点「新增板块」写第一块'),
        h(
          'div',
          { 'data-wk-card': '' },
          h('div', { 'data-wk-label': '' }, '拼出来是这样'),
          h('pre', { 'data-wk-pre': '' }, preview || '（全关掉了，注入里只有心情和好感两行）'),
        ),
      )
    }

    /* ── 页签二：心情 · 好感度 ─────────────────────────────── */
    function MoodPane(s) {
      var mood = s.mood || { emotion: '平静', intensity: 0.5, base: 0.5, hours: 0, band: '有感觉', level: 5 }
      var aff = s.affinity || { value: 45, stage: '平常', stages: [], auto: true }
      var dice = s.dice || { enabled: true, everyMinutes: 45, sides: 6, lastAt: 0, lastRoll: 0, lastEmotion: '', pct: {}, history: [] }
      var meme = s.meme || { enabled: true, emotion: mood.emotion || '平静', tag: 'daily', tags: [] }
      var id = useState(Math.round((mood.intensity || 0.5) * 100))
      var intensityDraft = id[0]
      var setIntensityDraft = id[1]
      var ad = useState(aff.value || 0)
      var affDraft = ad[0]
      var setAffDraft = ad[1]
      var kd = useState('emotion')
      var styleKind = kd[0]
      var setStyleKind = kd[1]
      var ke = useState(mood.emotion || '平静')
      var styleEmo = ke[0]
      var setStyleEmo = ke[1]
      var ks = useState(aff.stage || '平常')
      var styleStage = ks[0]
      var setStyleStage = ks[1]
      var ed = useState({})
      var edits = ed[0]
      var setEdits = ed[1]
      var it = useState(aff.interest != null ? aff.interest : 55)
      var interestDraft = it[0]
      var setInterestDraft = it[1]
      var dd = useState(dice.everyMinutes || 45)
      var diceDraft = dd[0]
      var setDiceDraft = dd[1]

      var styles = mood.styles || {}
      var stages = aff.stages && aff.stages.length ? aff.stages : []
      var key = styleKind === 'emotion' ? styleEmo : styleStage
      var serverText = ''
      if (styleKind === 'emotion') serverText = styles[styleEmo] || ''
      else {
        for (var i = 0; i < stages.length; i++) if (stages[i].key === styleStage) serverText = stages[i].style || ''
      }
      var editKey = styleKind + ':' + key
      var current = edits[editKey] != null ? edits[editKey] : serverText

      function setEditText(v) {
        var next = {}
        for (var k in edits) next[k] = edits[k]
        next[editKey] = v
        setEdits(next)
      }

      return h(
        'div',
        { 'data-wk-pane': '' },

        h(
          'div',
          { 'data-wk-card': '' },
          h('div', { 'data-wk-label': '' }, '此刻'),
          h(
            'div',
            { 'data-wk-row': '' },
            h('span', { 'data-wk-name': '', style: { fontSize: '15px' } }, mood.emotion || '平静'),
            h('span', { 'data-wk-sub': '' }, (mood.band || '') + ' · ' + (mood.level || 5) + '/10'),
            h('span', { 'data-wk-spacer': '' }),
            h('span', { 'data-wk-hint': '' }, '好感 ' + (aff.stage || '平常') + ' · ' + (aff.value || 0) + '/100'),
          ),
          h('div', { 'data-wk-meter': '' }, h('i', { style: { width: Math.round((mood.intensity || 0) * 100) + '%' } })),
          h(
            'div',
            { 'data-wk-hint': '' },
            '基准 ' +
              Math.round((mood.base || 0) * 100) +
              '%' +
              (mood.hours > 0 ? ' · 过了 ' + mood.hours + ' 小时，回淡到 ' + Math.round((mood.intensity || 0) * 100) + '%' : ' · 刚更新') +
              ' · 半衰期 6 小时',
          ),
          h(
            'div',
            { 'data-wk-hint': '' },
            '心情定语气，好感定距离；两者一起决定回话时多黏、多冲、多客气。',
          ),
        ),

        h(
          'div',
          { 'data-wk-card': '' },
          h('div', { 'data-wk-label': '' }, '换成哪种心情'),
          h(
            'div',
            { 'data-wk-chips': '' },
            EMO_LIST.map(function (name) {
              return h(
                'button',
                {
                  key: name,
                  'data-wk-chip': '',
                  'data-on': (mood.emotion || '平静') === name ? '' : undefined,
                  disabled: s.busy,
                  onClick: function () {
                    s.setMood(name, intensityDraft / 100)
                  },
                },
                h('i', null, name),
                h('em', null, EMO_HINT[name] || ''),
              )
            }),
          ),
        ),

        h(
          'div',
          { 'data-wk-card': '' },
          h('div', { 'data-wk-label': '' }, '浓淡（这次有多浓）'),
          h(
            'div',
            { 'data-wk-row': '' },
            h('input', {
              'data-wk-range': '',
              type: 'range',
              min: '10',
              max: '100',
              step: '5',
              value: intensityDraft,
              disabled: s.busy,
              onChange: function (e) {
                setIntensityDraft(Number(e.target.value))
              },
              onPointerUp: function (e) {
                s.setMood(mood.emotion || '平静', Number(e.target.value) / 100)
              },
              onKeyUp: function (e) {
                s.setMood(mood.emotion || '平静', Number(e.target.value) / 100)
              },
            }),
            h('span', { 'data-wk-num': '' }, intensityDraft + '%'),
            h('span', { 'data-wk-sub': '' }, intensityDraft >= 67 ? '很浓' : intensityDraft >= 34 ? '有感觉' : '淡淡的'),
          ),
          h('div', { 'data-wk-hint': '' }, '浓淡会往 40% 的基线回淡，半衰期 6 小时；刚被打动时最浓。'),
        ),

        h(
          'div',
          { 'data-wk-card': '' },
          h(
            'div',
            { 'data-wk-label': '' },
            '好感度',
            h('span', { 'data-wk-hint': '' }, '（' + (aff.stage || '平常') + ' · ' + (aff.value || 0) + '/100）'),
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h('input', {
              'data-wk-range': '',
              type: 'range',
              min: '0',
              max: '100',
              step: '1',
              value: affDraft,
              disabled: s.busy,
              onChange: function (e) {
                setAffDraft(Number(e.target.value))
              },
              onPointerUp: function (e) {
                s.setAffinity(Number(e.target.value))
              },
              onKeyUp: function (e) {
                s.setAffinity(Number(e.target.value))
              },
            }),
            h('span', { 'data-wk-num': '' }, affDraft),
            h(
              'button',
              {
                'data-wk-btn': '',
                disabled: s.busy,
                onClick: function () {
                  var v = Math.max(0, (aff.value || 0) - 5)
                  setAffDraft(v)
                  s.setAffinity(v)
                },
              },
              '-5',
            ),
            h(
              'button',
              {
                'data-wk-btn': '',
                disabled: s.busy,
                onClick: function () {
                  var v = Math.min(100, (aff.value || 0) + 5)
                  setAffDraft(v)
                  s.setAffinity(v)
                },
              },
              '+5',
            ),
          ),
          h(
            'div',
            { 'data-wk-chips': '' },
            ['厌恶', '冷漠', '平常', '关心', '喜爱'].map(function (name) {
              return h(
                'span',
                {
                  key: name,
                  'data-wk-chip': '',
                  'data-on': (aff.stage || '平常') === name ? '' : undefined,
                  style: { padding: '5px 9px', cursor: 'default' },
                },
                h('i', null, name),
                h('em', null, STAGE_HINT[name] || ''),
              )
            }),
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h(Toggle, {
              label: '聊天会自动涨（每 40 条 +1）',
              checked: aff.auto !== false,
              disabled: s.busy,
              onChange: function (v) {
                s.save({ affinity: { auto: v } }, v ? '会自己涨了' : '不自动涨了')
              },
            }),
            h('span', { 'data-wk-spacer': '' }),
            h('span', { 'data-wk-hint': '' }, '已聊 ' + (aff.msgCount || 0) + ' 条'),
          ),
        ),

        h(
          'div',
          { 'data-wk-card': '' },
          h(
            'div',
            { 'data-wk-label': '' },
            '对你话题的兴趣',
            h('span', { 'data-wk-hint': '' }, '（' + (aff.interestLevel || '有点兴趣') + ' · ' + (aff.interest || 0) + '/100）'),
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h('input', {
              'data-wk-range': '',
              type: 'range',
              min: '0',
              max: '100',
              step: '1',
              value: interestDraft,
              disabled: s.busy,
              onChange: function (e) {
                setInterestDraft(Number(e.target.value))
              },
              onPointerUp: function (e) {
                s.setInterest(Number(e.target.value))
              },
              onKeyUp: function (e) {
                s.setInterest(Number(e.target.value))
              },
            }),
            h('span', { 'data-wk-num': '' }, interestDraft),
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h(Toggle, {
              label: '跟着话题自己升降',
              checked: aff.autoInterest !== false,
              disabled: s.busy,
              onChange: function (v) {
                s.save({ affinity: { autoInterest: v } }, v ? '会自己升了' : '不自己升了')
              },
            }),
            h('span', { 'data-wk-spacer': '' }),
            h('span', { 'data-wk-hint': '' }, aff.topicNote ? '最近在聊：' + aff.topicNote : '还没聊到让她来劲的话题'),
          ),
          h('div', { 'data-wk-hint': '' }, '兴趣是她自己的：高就顺着这话题多聊一句、可以追问；低就简短带过，别硬撑。'),
        ),

        h(
          'div',
          { 'data-wk-card': '' },
          h(
            'div',
            { 'data-wk-label': '' },
            '心情骰子',
            h('span', { 'data-wk-hint': '' }, '（按好感度定权重，到点自己掷）'),
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h(Toggle, {
              label: '自动掷',
              checked: dice.enabled !== false,
              disabled: s.busy,
              onChange: function (v) {
                s.save({ dice: { enabled: v } }, v ? '会自己掷了' : '不自动掷了')
              },
            }),
            h('span', { 'data-wk-spacer': '' }),
            h('span', { 'data-wk-hint': '', 'data-wk-dice-hint': '' }, diceHint(dice, mood)),
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h(Toggle, {
              label: '什么时候投我自己定',
              checked: dice.selfPaced === true,
              disabled: s.busy,
              onChange: function (v) {
                s.save({ dice: { selfPaced: v } }, v ? '到点先看我心情' : '到点就投')
              },
            }),
            h('span', { 'data-wk-spacer': '' }),
            h(
              'span',
              { 'data-wk-hint': '' },
              dice.selfPaced === true
                ? (dice.appetite && dice.appetite.want === false ? '这一轮不投：' + dice.appetite.why : '这一轮想投：' + ((dice.appetite && dice.appetite.why) || '有点想知道会落到哪儿')) +
                  (dice.skipped ? ' · 已跳过 ' + dice.skipped + ' 次' : '')
                : '现在到点就投',
            ),
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h('span', { 'data-wk-hint': '' }, '每'),
            h('input', {
              'data-wk-num-in': '',
              type: 'number',
              min: '5',
              max: '1440',
              step: '5',
              value: diceDraft,
              disabled: s.busy,
              onChange: function (e) {
                setDiceDraft(Number(e.target.value))
              },
              onBlur: function () {
                if (diceDraft !== dice.everyMinutes) s.save({ dice: { everyMinutes: diceDraft } }, '骰子间隔已改')
              },
            }),
            h('span', { 'data-wk-hint': '' }, '分钟掷一次' + (dice.nextAt ? ' · 下一次 ' + when(dice.nextAt) : '')),
            h('span', { 'data-wk-spacer': '' }),
            h(
              'button',
              {
                'data-wk-btn': '',
                'data-primary': '',
                disabled: s.busy,
                onClick: function () {
                  s.rollDice()
                },
              },
              '现在掷一次',
            ),
          ),
          h(
            'div',
            { 'data-wk-chips': '' },
            EMO_LIST.map(function (name) {
              var v = dice.pct && dice.pct[name] != null ? dice.pct[name] : 0
              return h(
                'span',
                {
                  key: name,
                  'data-wk-chip': '',
                  'data-on': (dice.lastEmotion || '') === name ? '' : undefined,
                  style: { padding: '4px 9px', cursor: 'default', opacity: v < 1 ? 0.4 : 1 },
                },
                h('i', null, name),
                h('em', null, v + '%'),
              )
            }),
          ),
          h('div', { 'data-wk-hint': '' }, '好感越高越容易掷出高兴/喜欢，越低越容易出难过/生气/厌恶；点数只是好看，真正决定心情的是那条概率。'),
        ),

        h(
          'div',
          { 'data-wk-card': '' },
          h(
            'div',
            { 'data-wk-label': '' },
            '表情包',
            h('span', { 'data-wk-hint': '' }, '（心情决定发哪一类，需要装了 dsh-meme）'),
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h(Toggle, {
              label: '心情到了就顺手发张图',
              checked: meme.enabled !== false,
              disabled: s.busy,
              onChange: function (v) {
                s.save({ meme: { enabled: v } }, v ? '会自己发图了' : '只说话，不发图')
              },
            }),
            h('span', { 'data-wk-spacer': '' }),
            h('span', { 'data-wk-hint': '' }, '现在偏 ' + (meme.emotion || mood.emotion || '平静') + ' → ' + (meme.tag || 'daily')),
          ),
          h(
            'div',
            { 'data-wk-chips': '' },
            (meme.tags && meme.tags.length ? meme.tags : []).map(function (t) {
              return h(
                'span',
                {
                  key: t.emotion,
                  'data-wk-chip': '',
                  'data-on': t.tag === meme.tag ? '' : undefined,
                  style: { padding: '4px 9px', cursor: 'default' },
                },
                h('i', null, t.emotion),
                h('em', null, t.tag),
              )
            }),
          ),
          h('div', { 'data-wk-hint': '' }, '高兴/喜欢 → happy，难过 → sad，生气 → angry，害怕 → shy，平静/寂寞/厌恶 → daily。主人办正事时它会克制，一次对话不连发。'),
        ),

        h(
          'div',
          { 'data-wk-card': '' },
          h('div', { 'data-wk-label': '' }, '这种状态下怎么做'),
          h(
            'div',
            { 'data-wk-row': '' },
            h(Seg, {
              value: styleKind,
              options: [
                { id: 'emotion', label: '心情' },
                { id: 'stage', label: '好感阶段' },
              ],
              onChange: setStyleKind,
            }),
          ),
          h(
            'div',
            { 'data-wk-chips': '' },
            (styleKind === 'emotion' ? EMO_LIST : ['厌恶', '冷漠', '平常', '关心', '喜爱']).map(function (name) {
              var on = styleKind === 'emotion' ? styleEmo === name : styleStage === name
              return h(
                'button',
                {
                  key: name,
                  'data-wk-chip': '',
                  'data-on': on ? '' : undefined,
                  disabled: s.busy,
                  style: { padding: '4px 10px' },
                  onClick: function () {
                    if (styleKind === 'emotion') setStyleEmo(name)
                    else setStyleStage(name)
                  },
                },
                h('i', null, name),
              )
            }),
          ),
          h('textarea', {
            'data-wk-textarea': '',
            style: { minHeight: '86px' },
            value: current,
            spellCheck: false,
            placeholder: '这一状态下她会怎么说话、怎么动、做什么……',
            onChange: function (e) {
              setEditText(e.target.value)
            },
          }),
          h(
            'div',
            { 'data-wk-row': '' },
            h(
              'button',
              {
                'data-wk-btn': '',
                'data-primary': '',
                disabled: s.busy || current === serverText || !String(current || '').trim(),
                onClick: function () {
                  s.saveStyle(styleKind, key, current)
                },
              },
              '保存做法',
            ),
            h(
              'button',
              {
                'data-wk-btn': '',
                disabled: s.busy || current === serverText,
                onClick: function () {
                  setEditText(serverText)
                },
              },
              '还原',
            ),
            h('span', { 'data-wk-hint': '' }, current === serverText ? '和现在生效的一致' : '有未保存的修改'),
          ),
        ),
      )
    }

    /* ── 页签三：记忆 ─────────────────────────────────────── */
    function MemoryRow(p) {
      var st = useState(pct(p.item.weight))
      var draft = st[0]
      var setDraft = st[1]
      var ei = useState(null)
      var editing = ei[0]
      var setEditing = ei[1]
      var keep = p.item.retention == null ? null : Math.round(Number(p.item.retention) * 100)
      return h(
        'div',
        { 'data-wk-item': '' },
        h('span', { 'data-wk-tag': p.item.kind === 'fact' ? 'fact' : 'event' }, p.item.kind === 'fact' ? '事实' : '事件'),
        h(
          'span',
          { 'data-wk-tag': 'tier' + (p.item.tier || 2) },
          p.item.tierLabel || ['一档', '二档', '三档'][(p.item.tier || 2) - 1],
        ),
        h(
          'span',
          { 'data-wk-tag': p.item.lane === 'work' ? 'work' : 'chat' },
          p.item.lane === 'work' ? '工作' : '闲聊',
        ),
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '5px' } },
          editing == null
            ? h(
                'div',
                { 'data-wk-row': '', style: { gap: '8px', alignItems: 'baseline' } },
                h('div', { 'data-text': '' }, p.item.text),
                keep == null ? null : h('span', { 'data-wk-note': '', title: '还记得住的概率（越接近 100% 越牢）' }, '记着 ' + keep + '%'),
              )
            : h('textarea', {
                'data-wk-textarea': '',
                rows: '3',
                value: editing,
                disabled: p.busy,
                onChange: function (e) {
                  setEditing(e.target.value)
                },
              }),
          h(
            'div',
            { 'data-wk-row': '', style: { gap: '7px' } },
            h('input', {
              'data-wk-range': '',
              style: { flex: '0 1 120px', minWidth: '90px' },
              type: 'range',
              min: '0',
              max: '100',
              step: '5',
              value: draft,
              disabled: p.busy,
              onChange: function (e) {
                setDraft(Number(e.target.value))
              },
              onPointerUp: function (e) {
                p.onWeight(p.item.id, Number(e.target.value) / 100)
              },
              onKeyUp: function (e) {
                p.onWeight(p.item.id, Number(e.target.value) / 100)
              },
            }),
            h('span', { 'data-wk-num': '', style: { minWidth: '38px' } }, draft + '%'),
            p.item.tags && p.item.tags.length
              ? h(
                  'span',
                  { 'data-wk-hint': '' },
                  p.item.tags
                    .map(function (t) {
                      return '#' + t
                    })
                    .join(' '),
                )
              : null,
            h('span', { 'data-wk-spacer': '' }),
            editing == null
              ? h(
                  'button',
                  {
                    'data-wk-btn': '',
                    'data-mini': '',
                    disabled: p.busy,
                    onClick: function () {
                      setEditing(p.item.text)
                    },
                  },
                  '改',
                )
              : h(
                  'button',
                  {
                    'data-wk-btn': '',
                    'data-mini': '',
                    disabled: p.busy,
                    onClick: function () {
                      var next = String(editing || '').trim()
                      if (!next) return
                      setEditing(null)
                      p.onEdit(p.item.id, next)
                    },
                  },
                  '存',
                ),
            editing == null
              ? p.item.edits
                ? h(
                    'button',
                    {
                      'data-wk-btn': '',
                      'data-mini': '',
                      disabled: p.busy,
                      onClick: function () {
                        p.onRestore(p.item.id)
                      },
                    },
                    '还原',
                  )
                : null
              : h(
                  'button',
                  {
                    'data-wk-btn': '',
                    'data-mini': '',
                    disabled: p.busy,
                    onClick: function () {
                      setEditing(null)
                    },
                  },
                  '算了',
                ),
            h(
              'button',
              {
                'data-wk-btn': '',
                'data-mini': '',
                disabled: p.busy,
                onClick: function () {
                  p.onDelete(p.item.id)
                },
              },
              '删',
            ),
          ),
        ),
        h('time', null, when(p.item.t)),
      )
    }
    function MemoryPane(s) {
      var m = s.memory || {}
      var ti = m.tiers || {}
      return h(
        'div',
        { 'data-wk-pane': '' },
        h(
          'div',
          { 'data-wk-card': '' },
          h(
            'div',
            { 'data-wk-label': '' },
            '记一条',
            h('span', { 'data-wk-hint': '' }, '共 ' + (m.count || 0) + ' 条 · 事实 ' + (m.facts || 0) + ' · 事件 ' + (m.events || 0)),
            h('span', { 'data-wk-spacer': '' }),
            h(Toggle, {
              checked: m.enabled !== false,
              disabled: s.busy,
              label: '记忆开关',
              onChange: function (v) {
                s.save({ memory: { enabled: v } }, v ? '记忆已开' : '记忆已关')
              },
            }),
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h('input', {
              'data-wk-input': '',
              placeholder: '比如「主人喜欢薄荷色的界面」',
              value: s.memText,
              disabled: s.busy,
              onKeyDown: function (e) {
                if (e.key === 'Enter') s.addMemory()
              },
              onChange: function (e) {
                s.setMemText(e.target.value)
              },
            }),
            h(
              'button',
              { 'data-wk-btn': '', 'data-primary': '', disabled: s.busy || !s.memText.trim(), onClick: s.addMemory },
              '记住',
            ),
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h(Seg, {
              value: s.memKind,
              disabled: s.busy,
              options: [
                { id: 'fact', label: '事实' },
                { id: 'event', label: '事件' },
              ],
              onChange: s.setMemKind,
            }),
            h(Seg, {
              value: s.memLane,
              disabled: s.busy,
              options: [
                { id: 'auto', label: '自己分' },
                { id: 'work', label: '工作' },
                { id: 'chat', label: '闲聊' },
              ],
              onChange: s.setMemLane,
            }),
            h(Slider, {
              label: '权重',
              width: 34,
              value: s.memWeight,
              disabled: s.busy,
              onChange: s.setMemWeight,
            }),
            h('span', { 'data-wk-hint': '' }, '权重高的更容易被想起来'),
          ),
          h(
            'div',
            { 'data-wk-hint': '' },
            '工作：不存语气词，只留结论和步骤；闲聊：留一句短的。手写这条按原样存。',
          ),
        ),

        h(
          'div',
          { 'data-wk-card': '' },
          h(
            'div',
            { 'data-wk-label': '' },
            '自主保存',
            h('span', { 'data-wk-hint': '' }, '（每 ' + ((m.auto && m.auto.everyTurns) || 10) + ' 轮整理一次）'),
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h(Toggle, {
              label: '自己记',
              checked: m.auto ? m.auto.enabled !== false : true,
              disabled: s.busy,
              onChange: function (v) {
                s.save({ memory: { auto: { enabled: v } } }, v ? '会自己记了' : '不自己记了')
              },
            }),
            h(
              'div',
              { 'data-wk-row': '', style: { gap: '6px' } },
              h('span', { 'data-wk-hint': '' }, '每'),
              h('input', {
                'data-wk-num-in': '',
                type: 'number',
                min: '2',
                max: '50',
                value: s.autoEvery,
                disabled: s.busy,
                onChange: function (e) {
                  s.setAutoEvery(Number(e.target.value))
                },
                onBlur: function () {
                  if (s.autoEvery !== ((m.auto && m.auto.everyTurns) || 10))
                    s.save({ memory: { auto: { everyTurns: s.autoEvery } } }, '自主保存间隔已改')
                },
              }),
              h('span', { 'data-wk-hint': '' }, '轮'),
            ),
            h('span', { 'data-wk-spacer': '' }),
            h(
              'button',
              {
                'data-wk-btn': '',
                'data-primary': '',
                disabled: s.busy,
                onClick: function () {
                  s.autoMemoryNow()
                },
              },
              '现在整理一次',
            ),
          ),
          h(
            'div',
            { 'data-wk-hint': '' },
            m.auto && m.auto.lastAt ? '上次整理：' + when(m.auto.lastAt) : '还没整理过——攒几句再点。',
          ),
        ),

        h(
          'div',
          { 'data-wk-card': '' },
          h(
            'div',
            { 'data-wk-label': '' },
            '记忆档位',
            h('span', { 'data-wk-hint': '' }, '一档 ' + (ti.one || 0) + ' · 二档 ' + (ti.two || 0) + ' · 三档 ' + (ti.three || 0)),
            h('span', { 'data-wk-spacer': '' }),
            h(Toggle, {
              label: '自动归档',
              checked: ti.enabled !== false,
              disabled: s.busy,
              onChange: function (v) {
                s.save({ memory: { tiers: { enabled: v } } }, v ? '会自动归档了' : '不再自动归档')
              },
            }),
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h(Seg, {
              value: s.tierFilter,
              disabled: s.busy,
              options: [
                { id: 'all', label: '全部' },
                { id: '1', label: '一档' },
                { id: '2', label: '二档' },
                { id: '3', label: '三档' },
              ],
              onChange: s.setTierFilter,
            }),
            h('span', { 'data-wk-spacer': '' }),
            h('button', { 'data-wk-btn': '', disabled: s.busy, onClick: s.decayNow }, '归档一次'),
            h('button', { 'data-wk-btn': '', disabled: s.busy, onClick: s.healthNow }, '记忆体检'),
          ),
          h(
            'div',
            { 'data-wk-hint': '' },
            '一档是底线（权重 ≥0.8，或者 ≥0.65 且被想起过 3 次以上），二档常用，三档是杂记：' +
              '权重 <0.3、留存率掉到 50% 以下、或 ' +
              (ti.staleDays || 60) +
              ' 天没再被提起，都会被压到三档；被想起来权重会自己抬回来。',
          ),
          s.health
            ? h(
                'div',
                { 'data-wk-hint': '' },
                '体检：重复 ' +
                  ((s.health.duplicates && s.health.duplicates.length) || 0) +
                  ' 组 · 从没被想起 ' +
                  (s.health.neverRecalled || 0) +
                  ' 条 · 太久没动 ' +
                  (s.health.stale || 0) +
                  ' 条',
              )
            : null,
        ),

        h(
          'div',
          { 'data-wk-card': '' },
          h(
            'div',
            { 'data-wk-label': '' },
            '记忆列表',
            h(
              'span',
              { 'data-wk-hint': '' },
              '工作 ' + (m.work || 0) + ' · 闲聊 ' + (m.chat || 0) + ' · 拖滑条改权重，松开即存',
            ),
            h('span', { 'data-wk-spacer': '' }),
            h(Seg, {
              value: s.laneFilter,
              disabled: s.busy,
              options: [
                { id: 'all', label: '全部' },
                { id: 'work', label: '工作' },
                { id: 'chat', label: '闲聊' },
              ],
              onChange: s.setLaneFilter,
            }),
          ),
          (function () {
            var shown = s.items.filter(function (it) {
              if (s.laneFilter !== 'all' && it.lane !== s.laneFilter) return false
              if (s.tierFilter !== 'all' && String(it.tier || 2) !== String(s.tierFilter)) return false
              return true
            })
            if (!shown.length)
              return h(
                'div',
                { 'data-wk-empty': '' },
                s.laneFilter === 'all' && s.tierFilter === 'all' ? '还没有记忆。让鲸鲸记点事，或者上面手写一条。' : '这个筛选下还没有。',
              )
            // 一次只铺一屏：记忆多了以后整段重绘会卡，按「再显示 20 条」慢慢放
            var cap = Math.min(shown.length, s.listCap)
            var part = shown.slice(0, cap)
            return h(
              'div',
              { 'data-wk-list': '' },
              part.map(function (item) {
                return h(MemoryRow, {
                  key: item.id,
                  item: item,
                  busy: s.busy,
                  onWeight: s.setWeight,
                  onDelete: s.deleteMemory,
                  onEdit: s.editMemory,
                  onRestore: s.restoreMemory,
                })
              }),
              cap < shown.length
                ? h(
                    'button',
                    { type: 'button', 'data-wk-btn': '', onClick: function () { s.setListCap(cap + 20) } },
                    '再显示 ' + Math.min(20, shown.length - cap) + ' 条（还有 ' + (shown.length - cap) + '）',
                  )
                : null,
            )
          })(),
        ),

        h(
          'div',
          { 'data-wk-card': '' },
          h(
            'div',
            { 'data-wk-label': '' },
            '边线搭话',
            h('span', { 'data-wk-hint': '' }, '快忘的那层 ' + ((m.edge && m.edge.count) || 0) + ' 条 · 每 ' + ((m.edge && m.edge.everyDays) || 5) + ' 天自己挑一条'),
            h('span', { 'data-wk-spacer': '' }),
            h(Toggle, {
              checked: !(m.edge && m.edge.enabled === false),
              disabled: s.busy,
              label: '到点自己挑',
              onChange: function (v) {
                s.save({ memory: { edge: { enabled: v } } }, v ? '边线搭话开了' : '边线搭话关了')
              },
            }),
          ),
          m.edge && m.edge.pendingText
            ? h('div', { 'data-wk-quote': '' }, '【想问问】' + m.edge.pendingText)
            : h('div', { 'data-wk-hint': '' }, '这会儿没有挂着的话题。'),
          h(
            'div',
            { 'data-wk-row': '' },
            h('button', { 'data-wk-btn': '', disabled: s.busy, onClick: s.pickEdgeNow }, '挑一条'),
            h('button', { 'data-wk-btn': '', disabled: s.busy || !(m.edge && m.edge.pendingText), onClick: s.clearEdgeNow }, '不问了'),
            h('span', { 'data-wk-spacer': '' }),
            h('span', { 'data-wk-hint': '' }, '挑出来的会以「想问问」挂在下一轮记忆块里'),
          ),
        ),
        h(
          'div',
          { 'data-wk-card': '' },
          h('div', { 'data-wk-label': '' }, '想起什么'),
          h(
            'div',
            { 'data-wk-row': '' },
            h('input', {
              'data-wk-input': '',
              placeholder: '打一句话，看看现在会想起哪几条',
              value: s.recallQuery,
              disabled: s.busy,
              onKeyDown: function (e) {
                if (e.key === 'Enter') s.tryRecall()
              },
              onChange: function (e) {
                s.setRecallQuery(e.target.value)
              },
            }),
            h('button', { 'data-wk-btn': '', disabled: s.busy, onClick: s.tryRecall }, '试一下'),
            h(
              'button',
              {
                'data-wk-btn': '',
                disabled: s.busy,
                onClick: function () {
                  s.loadRecallLast()
                },
              },
              '最近一次',
            ),
          ),
          s.trace && s.trace.rows && s.trace.rows.length
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                h(
                  'div',
                  { 'data-wk-hint': '' },
                  '查询「' +
                    (s.trace.query || '（空）') +
                    '」 · 分词 ' +
                    s.trace.tokens +
                    ' 个 · 选中 ' +
                    s.trace.rows.filter(function (r) {
                      return r.chosen
                    }).length +
                    ' 条',
                ),
                h(
                  'div',
                  { 'data-wk-list': '', style: { maxHeight: '220px' } },
                  s.trace.rows.map(function (r, i) {
                    return h(
                      'div',
                      { 'data-wk-item': '', key: r.id + '-' + i, style: { opacity: r.chosen ? 1 : 0.5 } },
                      h('span', { 'data-wk-tag': '' }, r.chosen ? '想' : '没'),
                      h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, r.text),
                      h(
                        'span',
                        { 'data-wk-hint': '', style: { whiteSpace: 'nowrap' } },
                        r.score.toFixed(2) + ' · ' + r.why,
                      ),
                    )
                  }),
                ),
              )
            : h('div', { 'data-wk-empty': '' }, '还没有召回记录 —— 聊两句，或者上面试一次。'),
        ),

        h(
          'div',
          { 'data-wk-card': '' },
          h('div', { 'data-wk-label': '' }, '打分权重', h('span', { 'data-wk-hint': '' }, '决定「想起来」偏向什么')),
          h(Slider, {
            label: '相关度',
            value: s.wRelevance,
            disabled: s.busy,
            onChange: s.setWRelevance,
          }),
          h(Slider, { label: '重要性', value: s.wImportance, disabled: s.busy, onChange: s.setWImportance }),
          h(Slider, { label: '新鲜度', value: s.wRecency, disabled: s.busy, onChange: s.setWRecency }),
          h(
            'div',
            { 'data-wk-row': '' },
            h('span', { 'data-wk-hint': '', style: { minWidth: 56 } }, '每次最多'),
            h('input', {
              'data-wk-num-in': '',
              type: 'number',
              min: '1',
              max: '8',
              value: s.injectMax,
              disabled: s.busy,
              onChange: function (e) {
                s.setInjectMax(Number(e.target.value))
              },
            }),
            h('span', { 'data-wk-hint': '' }, '条'),
            h(
              'button',
              {
                'data-wk-btn': '',
                'data-primary': '',
                disabled: s.busy,
                onClick: function () {
                  s.saveWeights()
                },
              },
              '保存权重',
            ),
          ),
          h(
            'div',
            { 'data-wk-hint': '' },
            '相关度：跟这句话字面重不重合；重要性：你给的权重；新鲜度：越久没用到分越低（半衰期 ' +
              (m.freshHalfLifeDays || 21) +
              ' 天）。',
          ),
        ),
      )
    }

    /* ── 页签四：日记 ─────────────────────────────────────── */
    function DiaryPane(s) {
      var d = (s.memory && s.memory.diary) || {}
      var r = (s.memory && s.memory.review) || {}
      return h(
        'div',
        { 'data-wk-pane': '' },
        h(
          'div',
          { 'data-wk-card': '' },
          h(
            'div',
            { 'data-wk-label': '' },
            '自己写日记',
            h('span', { 'data-wk-spacer': '' }),
            h(Toggle, {
              checked: d.enabled !== false,
              disabled: s.busy,
              label: '到点自动写',
              onChange: function (v) {
                s.save({ memory: { diary: { enabled: v } } }, v ? '日记已开' : '日记已关')
              },
            }),
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h('span', { 'data-wk-hint': '', style: { minWidth: 56 } }, '间隔'),
            h('input', {
              'data-wk-num-in': '',
              type: 'number',
              min: '15',
              max: '10080',
              value: s.diaryMinutes,
              disabled: s.busy,
              onChange: function (e) {
                s.setDiaryMinutes(Number(e.target.value))
              },
            }),
            h('span', { 'data-wk-hint': '' }, '分钟（' + perMin(s.diaryMinutes) + '）'),
            h(
              'button',
              { 'data-wk-btn': '', 'data-mini': '', disabled: s.busy, onClick: s.saveDiaryMinutes },
              '保存间隔',
            ),
          ),
          h(
            'div',
            { 'data-wk-chips': '' },
            DIARY_PRESETS.map(function (n) {
              return h(
                'button',
                {
                  key: n,
                  'data-wk-chip': '',
                  'data-on': Number(d.everyMinutes) === n ? '' : undefined,
                  disabled: s.busy,
                  onClick: function () {
                    s.setDiaryMinutes(n)
                    s.save({ memory: { diary: { everyMinutes: n } } }, '间隔改成 ' + perMin(n))
                  },
                },
                h('i', null, perMin(n)),
              )
            }),
          ),
          h(
            'div',
            { 'data-wk-hint': '' },
            '上次写完：' + when(d.lastAt) + ' · 下次：' + (d.enabled === false ? '关着' : inMinutes(d.nextAt)) +
              ' · 已有 ' + (s.memory.diaryCount || 0) + ' 篇',
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h(
              'button',
              {
                'data-wk-btn': '',
                'data-primary': '',
                disabled: s.writing || s.busy,
                onClick: s.writeDiary,
              },
              s.writing ? '正在写…' : '现在写一篇',
            ),
            h('span', { 'data-wk-hint': '' }, '用宿主当前的模型写，写完存进 journal.jsonl'),
          ),
        ),

        h(
          'div',
          { 'data-wk-card': '' },
          h(
            'div',
            { 'data-wk-label': '' },
            '复盘',
            h('span', { 'data-wk-spacer': '' }),
            h(Toggle, {
              checked: r.enabled !== false,
              disabled: s.busy,
              label: '到点自动复盘',
              onChange: function (v) {
                s.save({ memory: { review: { enabled: v } } }, v ? '复盘已开' : '复盘已关')
              },
            }),
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h('span', { 'data-wk-hint': '', style: { minWidth: 56 } }, '每隔'),
            h('input', {
              'data-wk-num-in': '',
              type: 'number',
              min: '1',
              max: '90',
              value: s.reviewDays,
              disabled: s.busy,
              onChange: function (e) {
                s.setReviewDays(Number(e.target.value))
              },
            }),
            h('span', { 'data-wk-hint': '' }, '天'),
            h(
              'button',
              { 'data-wk-btn': '', 'data-mini': '', disabled: s.busy, onClick: s.saveReviewDays },
              '保存',
            ),
            h('span', { 'data-wk-spacer': '' }),
            h(
              'button',
              { 'data-wk-btn': '', disabled: s.writing || s.busy, onClick: s.writeReview },
              s.writing ? '正在想…' : '现在复盘',
            ),
          ),
          h(
            'div',
            { 'data-wk-hint': '' },
            '上次复盘：' + when(r.lastAt) + ' · 下次：' + (r.enabled === false ? '关着' : inMinutes(r.nextAt)) + ' · 已有 ' + (s.memory.reviewCount || 0) + ' 次',
          ),
          s.memory.lastReview ? h('div', { 'data-wk-say': '' }, s.memory.lastReview) : null,
        ),

        h(
          'div',
          { 'data-wk-card': '' },
          h('div', { 'data-wk-label': '' }, '日记与复盘'),
          s.journal.length
            ? h(
                'div',
                { 'data-wk-list': '' },
                s.journal.map(function (j) {
                  return h(
                    'div',
                    { 'data-wk-item': '', key: j.id },
                    h('span', { 'data-wk-tag': j.kind === 'review' ? 'review' : '' }, j.kind === 'review' ? '复盘' : '日记'),
                    h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, j.text),
                    h('time', null, when(j.t)),
                    h(
                      'button',
                      {
                        'data-wk-btn': '',
                        'data-mini': '',
                        disabled: s.busy,
                        onClick: function () {
                          s.deleteJournal(j.id)
                        },
                      },
                      '删',
                    ),
                  )
                }),
              )
            : h('div', { 'data-wk-empty': '' }, '还没写过。到点会自动写，也可以点上面「现在写一篇」。'),
        ),
      )
    }

    /* ── 页签五：状态 ─────────────────────────────────────── */
    function StatusPane(s) {
      var st = s.status || {}
      var m = st.memory || {}
      var d = m.diary || {}
      var r = m.review || {}
      return h(
        'div',
        { 'data-wk-pane': '' },
        h(
          'div',
          { 'data-wk-card': '' },
          h('div', { 'data-wk-label': '' }, '运行'),
          h(
            'div',
            { 'data-wk-kv': '' },
            h('b', null, '版本'),
            h('span', null, 'v' + (st.version || '—')),
            h('b', null, '绑定 agent'),
            h('span', null, String(st.boundAgents || 0) + ' 个'),
            h('b', null, '已运行'),
            h('span', null, String(st.uptimeSec || 0) + ' 秒'),
            h('b', null, '心情'),
            h(
              'span',
              null,
              (s.mood.emotion || '平静') +
                ' · ' +
                (s.mood.band || '') +
                ' ' +
                (s.mood.level || 5) +
                '/10 · 好感 ' +
                ((s.affinity && s.affinity.stage) || '平常') +
                ' ' +
                ((s.affinity && s.affinity.value) || 0) +
                '/100',
            ),
            h('b', null, '记忆'),
            h('span', null, String(m.count || 0) + ' 条（事实 ' + (m.facts || 0) + ' / 事件 ' + (m.events || 0) + '）'),
            h('b', null, '日记'),
            h('span', null, String(m.diaryCount || 0) + ' 篇 · 间隔 ' + perMin(d.everyMinutes || 0)),
            h('b', null, '复盘'),
            h('span', null, String(m.reviewCount || 0) + ' 次 · 每 ' + (r.everyDays || 0) + ' 天'),
            h('b', null, '内核'),
            h('span', null, String(st.kernelChars || 0) + ' 字'),
          ),
        ),
        h(
          'div',
          { 'data-wk-card': '' },
          h('div', { 'data-wk-label': '' }, '存储'),
          h('div', { 'data-wk-mono': '' }, st.store || '~/.dsh/whale-core'),
          h('div', { 'data-wk-hint': '' }, 'settings.json 配置 · memory/bucket-年月.jsonl 记忆（按月分片，老的 memory.jsonl 会自动迁过来）· journal.jsonl 日记与复盘 · events.jsonl 事件线 · backups/ 快照 —— 全是纯文本，删了就是从零开始。'),
        ),
        h(
          'div',
          { 'data-wk-card': '' },
          h('div', { 'data-wk-label': '' }, '备份与搬家'),
          h(
            'div',
            { 'data-wk-row': '' },
            h(
              'button',
              { 'data-wk-btn': '', 'data-primary': '', type: 'button', disabled: Boolean(s.busy), onClick: s.exportNow },
              '导出到文件',
            ),
            h(
              'button',
              { 'data-wk-btn': '', type: 'button', disabled: Boolean(s.busy), onClick: s.pickImport },
              '选文件导入',
            ),
            h('input', {
              id: 'dsh-whale-core-import',
              type: 'file',
              accept: 'application/json,.json',
              style: { display: 'none' },
              onChange: function (e) {
                var f = e && e.target && e.target.files && e.target.files[0]
                if (f) s.importFile(f)
                if (e && e.target) e.target.value = ''
              },
            }),
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h('span', { 'data-wk-hint': '' }, '导入方式'),
            h(Seg, {
              value: s.importMode,
              options: [
                { id: 'merge', label: '合并' },
                { id: 'replace', label: '覆盖' },
              ],
              onChange: function (v) {
                s.setImportMode(v)
              },
            }),
          ),
          h(
            'div',
            { 'data-wk-hint': '' },
            '导出会把设置、记忆、日记复盘打成一个 json，拿到别的机器上导入就能接着用。合并只补没见过的条目；覆盖是整份换掉，当前数据会丢。上次导出：' +
              when(s.sync.lastExportAt) +
              ' · 上次导入：' +
              when(s.sync.lastImportAt),
          ),
        ),
        h(
          'div',
          { 'data-wk-card': '' },
          h(
            'div',
            { 'data-wk-label': '' },
            '自动快照',
            h('span', { 'data-wk-hint': '' }, '每 ' + ((s.sync && s.sync.backupEveryHours) || 12) + ' 小时整包备份，留最近 ' + ((s.sync && s.sync.keepBackups) || 3) + ' 份'),
            h('span', { 'data-wk-spacer': '' }),
            h('button', { 'data-wk-btn': '', 'data-primary': '', disabled: s.busy, onClick: s.backupNow }, '现在备份'),
          ),
          h('div', { 'data-wk-mono': '' }, (s.sync && s.sync.dir) || ''),
          h('div', { 'data-wk-hint': '' }, '上次备份：' + when(s.sync && s.sync.lastBackupAt)),
          s.sync && s.sync.backups && s.sync.backups.length
            ? s.sync.backups.slice(0, 5).map(function (b) {
                return h(
                  'div',
                  { 'data-wk-row': '', key: b.file },
                  h('span', { 'data-wk-mono': '' }, b.file),
                  h('span', { 'data-wk-spacer': '' }),
                  h('span', { 'data-wk-hint': '' }, Math.round((b.bytes || 0) / 1024) + ' KB'),
                )
              })
            : h('div', { 'data-wk-hint': '' }, '还没有备份，点「现在备份」来一份。'),
        ),
        h(
          'div',
          { 'data-wk-card': '' },
          h('div', { 'data-wk-label': '' }, '云端同步（GitHub 私有仓库）'),
          h(
            'div',
            { 'data-wk-row': '' },
            h('input', {
              'data-wk-input': '',
              type: 'text',
              placeholder: (s.gh && s.gh.repo) ? ('已存：' + s.gh.repo + '（要换就改）') : '填 owner/仓库名，或直接粘仓库链接',
              value: s.syncRepo || '',
              onChange: function (e) {
                s.setSyncRepo(e && e.target ? e.target.value : '')
              },
            }),
            h('button', { 'data-wk-btn': '', type: 'button', disabled: Boolean(s.busy), onClick: s.syncSave }, '保存'),
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h('input', {
              'data-wk-input': '',
              type: 'password',
              placeholder: s.gh && s.gh.hasToken ? 'Token 已存（要换就粘新的）' : 'GitHub Token（github_pat_… 或 ghp_…）',
              value: s.syncToken || '',
              onChange: function (e) {
                s.setSyncToken(e && e.target ? e.target.value : '')
              },
            }),
            h('button', { 'data-wk-btn': '', type: 'button', disabled: Boolean(s.busy), onClick: s.syncVerify }, '校验'),
            h('button', { 'data-wk-btn': '', type: 'button', disabled: Boolean(s.busy), onClick: s.syncCreateRepo }, '建仓库'),
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h(
              'button',
              { 'data-wk-btn': '', 'data-primary': '', type: 'button', disabled: Boolean(s.busy), onClick: s.syncUpload },
              '一键上传',
            ),
            h('button', { 'data-wk-btn': '', type: 'button', disabled: Boolean(s.busy), onClick: s.syncPull }, '拉取'),
            h('button', { 'data-wk-btn': '', type: 'button', disabled: Boolean(s.busy), onClick: s.syncMerge }, '合并'),
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h('input', {
              'data-wk-input': '',
              type: 'number',
              min: '0',
              max: '1440',
              placeholder: '自动上传（分钟，0=关）' + ((s.gh && s.gh.autoUploadMinutes) ? ' 现 ' + s.gh.autoUploadMinutes : ''),
              value: s.autoUpMin || '',
              onChange: function (e) {
                s.setAutoUpMin(e && e.target ? e.target.value : '')
              },
            }),
            h('input', {
              'data-wk-input': '',
              type: 'number',
              min: '0',
              max: '1440',
              placeholder: '自动合并（分钟，0=关）' + ((s.gh && s.gh.autoMergeMinutes) ? ' 现 ' + s.gh.autoMergeMinutes : ''),
              value: s.autoMergeMin || '',
              onChange: function (e) {
                s.setAutoMergeMin(e && e.target ? e.target.value : '')
              },
            }),
          ),
          h(
            'div',
            { 'data-wk-row': '' },
            h(
              'button',
              { 'data-wk-btn': '', type: 'button', disabled: Boolean(s.busy), onClick: s.toggleBootMerge },
              '开机自动合并：' + ((s.gh && s.gh.mergeOnBoot) ? '开' : '关'),
            ),
          ),
          h(
            'div',
            { 'data-wk-hint': '' },
            '每台设备只写自己那一片 data/设备ID.json，读取时按条目合并，所以多台机器同时用也不会互相盖掉。上传只带设置、人设、记忆和日记，不含 token、事件流和备份。',
          ),
          h(
            'div',
            { 'data-wk-hint': '' },
            '仓库：' +
              ((s.gh && s.gh.repo) || '还没设') +
              ' · 分支 ' +
              ((s.gh && s.gh.branch) || 'main') +
              ' · 本机 ' +
              ((s.gh && s.gh.deviceName) || '-') +
              '（' +
              ((s.gh && s.gh.deviceId) || '-') +
              '）',
          ),
          h('div', { 'data-wk-hint': '' }, '上次上传：' + when(s.gh && s.gh.lastUploadAt) + ' · 上次拉取：' + when(s.gh && s.gh.lastPullAt) + ' · 上次合并：' + when(s.gh && s.gh.lastMergeAt) + ((s.gh && s.gh.lastMergeAdded) ? '（+' + s.gh.lastMergeAdded + ' 条）' : '')),
          s.gh && s.gh.lastError
            ? h('div', { 'data-wk-hint': '' }, '上次出错（' + when(s.gh.lastErrorAt) + '）：' + s.gh.lastError)
            : null,
        ),
        h(
          'div',
          { 'data-wk-card': '' },
          h('div', { 'data-wk-label': '' }, '事件线与画像'),
          h(
            'div',
            { 'data-wk-kv': '' },
            h('b', null, '事件线'),
            h('span', null, String((m.ingest && m.ingest.eventCount) || 0) + ' 条'),
            h('b', null, '待整理'),
            h('span', null, String((m.ingest && m.ingest.pendingChars) || 0) + ' 字'),
            h('b', null, '改错留档'),
            h('span', null, String(m.revisions || 0) + ' 次'),
          ),
          m.profile && m.profile.facts && m.profile.facts.length
            ? h(
                'div',
                null,
                m.profile.facts.map(function (f) {
                  return h('div', { 'data-wk-hint': '', key: f }, '· ' + f)
                }),
              )
            : h('div', { 'data-wk-hint': '' }, '画像还没长出来，攒点记忆再说。'),
          h(
            'div',
            { 'data-wk-row': '' },
            h('button', { 'data-wk-btn': '', disabled: s.busy, onClick: s.ingestNow }, '现在整理一次'),
            h('button', { 'data-wk-btn': '', disabled: s.busy, onClick: s.refreshProfileNow }, '刷新画像'),
            h('span', { 'data-wk-spacer': '' }),
            h('span', { 'data-wk-hint': '' }, '事件线记着说过的话，被压缩掉的原话也在这儿'),
          ),
        ),
        h(
          'div',
          { 'data-wk-card': '' },
          h('div', { 'data-wk-label': '' }, '接口'),
          h('div', { 'data-wk-mono': '' }, 'GET  /whale-core/api/status'),
          h('div', { 'data-wk-mono': '' }, 'GET  /whale-core/api/memory?limit=40&kind=fact'),
          h('div', { 'data-wk-mono': '' }, 'GET  /whale-core/api/journal?limit=20'),
          h('div', { 'data-wk-mono': '' }, 'GET  /whale-core/api/recall?q=…  ·  /recall/last'),
          h('div', { 'data-wk-mono': '' }, 'POST /whale-core/api/memory  { text, kind, weight, tags }'),
          h('div', { 'data-wk-mono': '' }, 'POST /whale-core/api/memory/weight  { id, weight }'),
          h('div', { 'data-wk-mono': '' }, 'POST /whale-core/api/memory/delete  { id }'),
          h('div', { 'data-wk-mono': '' }, 'POST /whale-core/api/settings  { enabled, kernel, memory }'),
          h('div', { 'data-wk-mono': '' }, 'POST /whale-core/api/mood  { label, energy }'),
          h('div', { 'data-wk-mono': '' }, 'POST /whale-core/api/diary/now  ·  /review/now'),
        ),
      )
    }

    /* ── 面板 ─────────────────────────────────────────────── */

    // 崩溃兜底：某个页签渲染炸了也只坏这一块，不会把整个设置页拖成白屏
    var PaneBoundary = null
    if (React.Component) {
      PaneBoundary = function PaneBoundary(props) {
        React.Component.call(this, props)
        this.state = { err: '' }
      }
      PaneBoundary.prototype = Object.create(React.Component.prototype)
      PaneBoundary.prototype.constructor = PaneBoundary
      PaneBoundary.prototype.componentDidCatch = function (e) {
        this.setState({ err: String((e && e.message) || e || '未知错误') })
      }
      PaneBoundary.prototype.render = function () {
        if (this.state.err)
          return h(
            'div',
            { 'data-wk-card': '' },
            h('div', { 'data-wk-label': '' }, '这块渲染出错了'),
            h('div', { 'data-wk-note': '' }, this.state.err),
            h(
              'button',
              {
                type: 'button',
                'data-wk-btn': '',
                onClick: function () {
                  this.setState({ err: '' })
                }.bind(this),
              },
              '再试一次',
            ),
          )
        return this.props.children
      }
    }

    // 编辑器正在改哪套人设：'' = 默认那套（kernel）。放组件外面，换页签、重渲染都不丢
    var EDIT_PERSONA = ''

    function Panel() {
      var st = useState(null)
      var status = st[0]
      var setStatus = st[1]
      var et = useState('')
      var error = et[0]
      var setError = et[1]
      var ot = useState('')
      var notice = ot[0]
      var setNotice = ot[1]
      var bt = useState(false)
      var busy = bt[0]
      var setBusy = bt[1]
      var wt = useState(false)
      var writing = wt[0]
      var setWriting = wt[1]
      // GitHub 同步：仓库地址与 token 输入框（已存的 token 不回显，留空就沿用存的那把）
      var gr = useState('')
      var syncRepo = gr[0]
      var setSyncRepo = gr[1]
      var gk = useState('')
      var syncToken = gk[0]
      var setSyncToken = gk[1]
      // 自动同步的两个分钟数（0 或空 = 关）
      var gu = useState('')
      var autoUpMin = gu[0]
      var setAutoUpMin = gu[1]
      var gm = useState('')
      var autoMergeMin = gm[0]
      var setAutoMergeMin = gm[1]

      var kt = useState([])
      var sections = kt[0]
      var setSections = kt[1]
      var sk = useState([])
      var savedSections = sk[0]
      var setSavedSections = sk[1]
      // 人设库：personas 是另外几套（默认那套在 kernel 里），editId 为空表示正在改默认那套
      var pe = useState([])
      var personas = pe[0]
      var setPersonas = pe[1]
      var ei = useState('')
      var editId = ei[0]
      var setEditId = ei[1]
      var ai = useState('')
      var activeId = ai[0]
      var setActiveId = ai[1]
      var an = useState('默认人设')
      var activeName = an[0]
      var setActiveName = an[1]
      var pn = useState('')
      var personaName = pn[0]
      var setPersonaName = pn[1]
      var da = useState(false)
      var delAsk = da[0]
      var setDelAsk = da[1]
      // 默认那套的名字（能改）+ 会话清单（绑人设用）
      var kn = useState('默认人设')
      var kernelName = kn[0]
      var setKernelName = kn[1]
      var sn = useState([])
      var sessions = sn[0]
      var setSessions = sn[1]
      var bs = useState(0)
      var boundSessions = bs[0]
      var setBoundSessions = bs[1]
      // 归档的对话不列出来，只报个数量
      var av = useState(0)
      var archivedCount = av[0]
      var setArchivedCount = av[1]

      var mt = useState('')
      var memText = mt[0]
      var setMemText = mt[1]
      var mk = useState('fact')
      var memKind = mk[0]
      var setMemKind = mk[1]
      var ml = useState('auto')
      var memLane = ml[0]
      var setMemLane = ml[1]
      var lf = useState('all')
      var laneFilter = lf[0]
      var setLaneFilter = lf[1]
      var tf = useState('all')
      var tierFilter = tf[0]
      var setTierFilter = tf[1]
      var lc = useState(20)
      var listCap = lc[0]
      var setListCap = lc[1]
      var hh = useState(null)
      var health = hh[0]
      var setHealth = hh[1]
      var vi = useState('merge')
      var importMode = vi[0]
      var setImportMode = vi[1]
      var ae = useState(6)
      var autoEvery = ae[0]
      var setAutoEvery = ae[1]
      var mw = useState(60)
      var memWeight = mw[0]
      var setMemWeight = mw[1]
      var mi = useState([])
      var items = mi[0]
      var setItems = mi[1]
      var jr = useState([])
      var journal = jr[0]
      var setJournal = jr[1]
      var tr = useState(null)
      var trace = tr[0]
      var setTrace = tr[1]
      var rq = useState('')
      var recallQuery = rq[0]
      var setRecallQuery = rq[1]

      var wr = useState(50)
      var wRelevance = wr[0]
      var setWRelevance = wr[1]
      var wi = useState(30)
      var wImportance = wi[0]
      var setWImportance = wi[1]
      var wc = useState(20)
      var wRecency = wc[0]
      var setWRecency = wc[1]
      var im = useState(4)
      var injectMax = im[0]
      var setInjectMax = im[1]

      var dm = useState(180)
      var diaryMinutes = dm[0]
      var setDiaryMinutes = dm[1]
      var rd = useState(3)
      var reviewDays = rd[0]
      var setReviewDays = rd[1]

      var tt = useState(function () {
        try {
          var saved = localStorage.getItem(TAB_KEY)
          for (var i = 0; i < TABS.length; i++) if (TABS[i].id === saved) return saved
        } catch (e) {}
        return 'kernel'
      })
      var tab = tt[0]
      var setTab = tt[1]

      // 编辑器里放哪套：正在编辑某套人设就放那套，否则放默认那套
      function applyEditor(d, pz) {
        setKernelName(((d.kernel && d.kernel.name) || (pz && pz.kernelName) || '默认人设'))
        var wantId = EDIT_PERSONA
        var list = (pz && pz.list) || []
        var hit = null
        for (var i = 0; i < list.length; i += 1) if (list[i].id === wantId) hit = list[i]
        if (wantId && hit) {
          setPersonaName(hit.name)
          return getJson(API + '/persona?id=' + encodeURIComponent(wantId)).then(function (pd) {
            var ps = (pd && pd.sections) || []
            setSections(ps)
            setSavedSections(ps)
            return d
          })
        }
        EDIT_PERSONA = ''
        setEditId('')
        setPersonaName((d.kernel && d.kernel.name) || '默认人设')
        var secs = (d.kernel && d.kernel.sections) || []
        setSections(secs)
        setSavedSections(secs)
        return d
      }

      // 换个编辑目标：默认那套走 /status，别的走 /persona
      function selectPersona(id) {
        EDIT_PERSONA = id || ''
        setEditId(EDIT_PERSONA)
        setPersonaName(personaNameOf(EDIT_PERSONA))
        setDelAsk(false)
        setBusy(true)
        return getJson(EDIT_PERSONA ? API + '/persona?id=' + encodeURIComponent(EDIT_PERSONA) : API + '/status')
          .then(function (d) {
            var secs = EDIT_PERSONA ? (d && d.sections) || [] : (d && d.kernel && d.kernel.sections) || []
            setSections(secs)
            setSavedSections(secs)
          })
          .catch(function (e) {
            setError(String(e && e.message ? e.message : e))
          })
          .then(function () {
            setBusy(false)
          })
      }

      var load = useCallback(function () {
        return Promise.all([
          getJson(API + '/status'),
          getJson(API + '/memory?limit=60'),
          getJson(API + '/journal?limit=40'),
          getJson(API + '/recall/last'),
          getJson(API + '/sessions'),
        ])
          .then(function (all) {
            var d = all[0]
            if (!d || !d.ok) throw new Error((d && d.error) || '读取失败')
            setStatus(d)
            var pz = d.personas || {}
            setPersonas(pz.list || [])
            setActiveId(pz.activeId || '')
            setActiveName(pz.activeName || pz.kernelName || '默认人设')
            setKernelName(((d.kernel && d.kernel.name) || pz.kernelName || '默认人设'))
            var ses = all[4] || {}
            setSessions(Array.isArray(ses.items) ? ses.items : [])
            setBoundSessions(ses.boundSessions || 0)
            setArchivedCount(ses.archived || 0)
            var m = d.memory || {}
            setItems((all[1] && all[1].items) || [])
            setJournal((all[2] && all[2].items) || [])
            if (all[3] && all[3].trace) setTrace(all[3].trace)
            var w = m.weights || {}
            setWRelevance(pct(w.relevance))
            setWImportance(pct(w.importance))
            setWRecency(pct(w.recency))
            setInjectMax(m.injectMax || 3)
            setDiaryMinutes((m.diary && m.diary.everyMinutes) || 180)
            setReviewDays((m.review && m.review.everyDays) || 3)
            setAutoEvery((m.auto && m.auto.everyTurns) || 10)
            setError('')
            return applyEditor(d, pz)
          })
          .catch(function (e) {
            setError(String(e && e.message ? e.message : e))
          })
      }, [])

      // 只在挂载时拉一次；依赖写成 [] 是手动的（别跟 load 的引用走，防止某些 React 垫片里
      // useCallback 不稳定 → effect 反复触发 → 无限重渲染把整个页面拖死）
      useEffect(function () {
        load()
      }, [])

      function flash(msg) {
        setNotice(msg)
        setTimeout(function () {
          setNotice('')
        }, 2200)
      }

      function run(promise, okText) {
        setBusy(true)
        return promise
          .then(function (d) {
            if (!d || !d.ok) throw new Error((d && d.error) || '写入失败')
            return load()
          })
          .then(function () {
            if (okText) flash(okText)
          })
          .catch(function (e) {
            setError(String(e && e.message ? e.message : e))
          })
          .then(function () {
            setBusy(false)
          })
      }

      function save(patch, okText) {
        return run(postJson(API + '/settings', patch), okText)
      }

      function setMood(emotion, intensity) {
        return run(postJson(API + '/mood', { emotion: emotion, intensity: intensity }), '心情换成' + emotion)
      }

      function setAffinity(input) {
        var body = typeof input === 'number' ? { value: input } : input || {}
        return run(postJson(API + '/affinity', body), '好感度已更新')
      }

      function saveStyle(kind, key, text) {
        return run(postJson(API + '/style', { kind: kind, key: key, text: text }), '做法已保存')
      }

      function updateSection(id, patch) {
        setSections(function (prev) {
          return prev.map(function (x) {
            if (x.id !== id) return x
            var next = { id: x.id, label: x.label, text: x.text, enabled: x.enabled }
            if (patch && typeof patch.label === 'string') next.label = patch.label
            if (patch && typeof patch.text === 'string') next.text = patch.text
            if (patch && typeof patch.enabled === 'boolean') next.enabled = patch.enabled
            return next
          })
        })
      }

      function addSection() {
        setSections(function (prev) {
          if (prev.length >= 20) return prev
          return prev.concat([{ id: 's' + Date.now().toString(36), label: '新板块', text: '', enabled: true }])
        })
      }

      function removeSection(id) {
        setSections(function (prev) {
          if (prev.length <= 1) return prev
          return prev.filter(function (x) {
            return x.id !== id
          })
        })
      }

      function moveSection(id, dir) {
        setSections(function (prev) {
          var at = -1
          for (var i = 0; i < prev.length; i += 1) if (prev[i].id === id) at = i
          var to = at + dir
          if (at < 0 || to < 0 || to >= prev.length) return prev
          var next = prev.slice()
          var tmp = next[at]
          next[at] = next[to]
          next[to] = tmp
          return next
        })
      }

      // 保存板块：改的是默认那套就写 /settings，改的是别的人设就写 /persona
      function saveSections(secs, okText) {
        if (!EDIT_PERSONA) return save({ kernel: { sections: secs } }, okText)
        return run(postJson(API + '/persona', { action: 'save', id: EDIT_PERSONA, sections: secs }), okText)
      }

      function toggleSection(id, on) {
        var next = sections.map(function (x) {
          if (x.id !== id) return x
          return { id: x.id, label: x.label, text: x.text, enabled: on !== false }
        })
        setSections(next)
        return saveSections(next, on ? '板块已开' : '板块已关')
      }

      function saveKernel() {
        return saveSections(sections, EDIT_PERSONA ? '这套人设已保存' : '内核已保存')
      }

      /* ── 人设库 ── */
      function personaNameOf(id) {
        if (!id) return kernelName
        for (var i = 0; i < personas.length; i += 1) if (personas[i].id === id) return personas[i].name
        return '人设'
      }

      function createPersona() {
        setBusy(true)
        return postJson(API + '/persona', { action: 'create', id: EDIT_PERSONA, name: '新人设' })
          .then(function (d) {
            if (!d || !d.ok) throw new Error((d && d.error) || '新建失败')
            EDIT_PERSONA = d.id
            setEditId(d.id)
            flash('新建了「' + d.name + '」')
            return load()
          })
          .catch(function (e) {
            setError(String(e && e.message ? e.message : e))
          })
          .then(function () {
            setBusy(false)
          })
      }

      function renamePersona() {
        var name = String(personaName || '').trim()
        if (!name) return undefined
        // 默认那套不在 /persona 的列表里，名字存在 kernel 上，走 /settings
        if (!EDIT_PERSONA) {
          if (name === kernelName) return undefined
          setBusy(true)
          return postJson(API + '/settings', { kernel: { name: name } })
            .then(function (d) {
              if (!d || !d.ok) throw new Error((d && d.error) || '改名失败')
              setKernelName(name)
              flash('默认人设改叫「' + name + '」了')
              return load()
            })
            .catch(function (e) {
              setError(String(e && e.message ? e.message : e))
            })
            .then(function () {
              setBusy(false)
            })
        }
        if (name === personaNameOf(EDIT_PERSONA)) return undefined
        return run(postJson(API + '/persona', { action: 'rename', id: EDIT_PERSONA, name: name }), '改名了')
      }

      function makeDefault() {
        return run(postJson(API + '/persona', { action: 'default', id: EDIT_PERSONA }), EDIT_PERSONA ? '新会话默认用「' + personaNameOf(EDIT_PERSONA) + '」' : '新会话默认用默认人设')
      }

      function deletePersona() {
        if (!EDIT_PERSONA) return undefined
        if (!delAsk) {
          setDelAsk(true)
          setTimeout(function () {
            setDelAsk(false)
          }, 2500)
          return undefined
        }
        setDelAsk(false)
        setBusy(true)
        return postJson(API + '/persona', { action: 'delete', id: EDIT_PERSONA })
          .then(function (d) {
            if (!d || !d.ok) throw new Error((d && d.error) || '删不掉')
            EDIT_PERSONA = ''
            setEditId('')
            flash('删掉了')
            return load()
          })
          .catch(function (e) {
            setError(String(e && e.message ? e.message : e))
          })
          .then(function () {
            setBusy(false)
          })
      }

      // 会话清单：卡里「刷新列表」用，bind 完 load() 也会顺带刷
      function reloadSessions() {
        return getJson(API + '/sessions')
          .then(function (d) {
            var ses = d || {}
            setSessions(Array.isArray(ses.items) ? ses.items : [])
            setBoundSessions(ses.boundSessions || 0)
            setArchivedCount(ses.archived || 0)
          })
          .catch(function (e) {
            setError(String(e && e.message ? e.message : e))
          })
      }

      // 把某个对话绑到某套人设：id 空 = 解绑，回落到新会话默认
      function bindPersona(sid, id) {
        setBusy(true)
        return postJson(API + '/persona', { action: 'bind', sid: sid, id: id || '' })
          .then(function (d) {
            if (!d || !d.ok) throw new Error((d && d.error) || '绑定失败')
            flash('这个对话改用「' + d.name + '」')
            return load()
          })
          .catch(function (e) {
            setError(String(e && e.message ? e.message : e))
          })
          .then(function () {
            setBusy(false)
          })
      }

      function setInterest(input) {
        var body = typeof input === 'number' ? { value: input } : input || {}
        return run(postJson(API + '/interest', body), '兴趣度已更新')
      }

      function rollDice() {
        return run(postJson(API + '/dice/roll', {}), '掷完了')
      }

      // 导出：拿 blob 直接塞给 <a download>，浏览器会存到下载目录
      function exportNow() {
        setBusy(true)
        return fetch(API + '/export', { credentials: 'same-origin' })
          .then(function (res) {
            if (!res.ok) throw new Error('导出失败 ' + res.status)
            var name = 'whale-core.json'
            var cd = res.headers.get('Content-Disposition') || ''
            var mm = /filename="([^"]+)"/.exec(cd)
            if (mm) name = mm[1]
            return res.blob().then(function (b) {
              var url = URL.createObjectURL(b)
              var a = document.createElement('a')
              a.href = url
              a.download = name
              document.body.appendChild(a)
              a.click()
              document.body.removeChild(a)
              setTimeout(function () {
                URL.revokeObjectURL(url)
              }, 4000)
              flash('已导出 ' + name)
              return load()
            })
          })
          .catch(function (e) {
            setError(String(e && e.message ? e.message : e))
          })
          .then(function () {
            setBusy(false)
          })
      }

      function pickImport() {
        var el = document.getElementById('dsh-whale-core-import')
        if (el && el.click) el.click()
      }

      // 导入：读文件 → 解析 → 按合并/覆盖 POST /import
      function importFile(file) {
        if (!file) return
        setBusy(true)
        var parsed = file.text
          ? file.text().then(function (txt) {
              try {
                return JSON.parse(txt)
              } catch (e) {
                throw new Error('这个文件不是 JSON')
              }
            })
          : file.arrayBuffer().then(function (buf) {
              try {
                return JSON.parse(Buffer.from(buf).toString('utf8'))
              } catch (e) {
                throw new Error('这个文件不是 JSON')
              }
            })
        return parsed
          .then(function (data) {
            return postJson(API + '/import', { data: data, mode: importMode })
          })
          .then(function (d) {
            if (!d || !d.ok) throw new Error((d && d.error) || '导入失败')
            flash('导入完成：记忆 +' + ((d.memory && d.memory.added) || 0) + '，日记 +' + ((d.journal && d.journal.added) || 0))
            return load()
          })
          .catch(function (e) {
            setError(String(e && e.message ? e.message : e))
          })
          .then(function () {
            setBusy(false)
          })
      }

      function addMemory() {
        var text = memText.trim()
        if (!text) return
        setBusy(true)
        var body = { text: text, kind: memKind, weight: memWeight / 100, raw: true }
        if (memLane !== 'auto') body.lane = memLane
        postJson(API + '/memory', body)
          .then(function (d) {
            if (!d || !d.ok) throw new Error((d && d.error) || '写入失败')
            setMemText('')
            return load()
          })
          .then(function () {
            flash(memKind === 'fact' ? '记住了' : '这件事记下了')
          })
          .catch(function (e) {
            setError(String(e && e.message ? e.message : e))
          })
          .then(function () {
            setBusy(false)
          })
      }

      function autoMemoryNow() {
        return run(postJson(API + '/auto-memory', {}), '整理完了')
      }

      function setWeight(id, w) {
        return run(postJson(API + '/memory/weight', { id: id, weight: w }))
      }

      function deleteMemory(id) {
        return run(postJson(API + '/memory/delete', { id: id }), '删掉了')
      }

      function editMemory(id, text) {
        return run(postJson(API + '/memory/edit', { id: id, text: text }), '改好了，原来那条留着')
      }

      function restoreMemory(id) {
        return run(postJson(API + '/memory/restore', { id: id }), '还原回去了')
      }

      function pickEdgeNow() {
        return run(postJson(API + '/edge/pick', {}), '挑好了一条')
      }

      function clearEdgeNow() {
        return run(postJson(API + '/edge/clear', {}), '这条先不问')
      }

      function backupNow() {
        return run(postJson(API + '/backup/now', {}), '备份好了')
      }

      // ── GitHub 同步 ──
      // token 只在内存里；输入框空就用服务端已存的那把
      function syncBody(extra) {
        var out = extra || {}
        if (syncRepo && syncRepo.trim()) out.repo = syncRepo.trim()
        if (syncToken && syncToken.trim()) out.token = syncToken.trim()
        return out
      }

      function syncVerify() {
        return run(postJson(API + '/sync/verify', syncBody({})), '仓库连得上')
      }

      function syncCreateRepo() {
        var name = (syncRepo.split('/').pop() || '').trim() || 'whale-sync'
        return run(postJson(API + '/sync/create-repo', syncBody({ name: name })), '仓库准备好了')
      }

      function syncUpload() {
        return run(postJson(API + '/sync/upload', syncBody({})), '已经传到 GitHub')
      }

      function syncPull() {
        return run(postJson(API + '/sync/pull', syncBody({})), '拉下来了（看控制台）')
      }

      // 先预演再落地：预演有新增就直接合并，没有就只提示
      function syncMerge() {
        setBusy(true)
        return postJson(API + '/sync/merge', syncBody({ dryRun: true }))
          .then(function (d) {
            if (!d || !d.ok) throw new Error((d && d.error) || '合并预演失败')
            if (!d.addMemory && !d.addJournal) {
              flash('别的设备没有新东西')
              return load()
            }
            return postJson(API + '/sync/merge', syncBody({ dryRun: false })).then(function (r) {
              if (!r || !r.ok) throw new Error((r && r.error) || '合并失败')
              flash('合并完成：记忆 +' + (r.addMemory || 0) + '，日记 +' + (r.addJournal || 0) + '，重复跳过 ' + (r.conflict || 0))
              return load()
            })
          })
          .catch(function (e) {
            setError(errText(e))
          })
          .then(function () {
            setBusy(false)
          })
      }

      // 开机自动合并开关（改一次存一次）
      function toggleBootMerge() {
        var cur = (status && status.sync && status.sync.gh) || {}
        var next = !cur.mergeOnBoot
        setBusy(true)
        return postJson(API + '/sync/config', { mergeOnBoot: next })
          .then(function (d) {
            if (!d || !d.ok) throw new Error((d && d.error) || '存不进去')
            flash(next ? '开机后会自动合并一次' : '开机不再自动合并')
            return load()
          })
          .catch(function (e) {
            setError(errText(e))
          })
          .then(function () {
            setBusy(false)
          })
      }

      // 保存仓库地址与 token（不点上传也能先存着）
      function syncSave() {
        setBusy(true)
        var body = {}
        if (syncRepo && syncRepo.trim()) body.repo = syncRepo.trim()
        if (syncToken && syncToken.trim()) body.token = syncToken.trim()
        if (autoUpMin !== '' && autoUpMin !== null && autoUpMin !== undefined) body.autoUploadMinutes = Number(autoUpMin) || 0
        if (autoMergeMin !== '' && autoMergeMin !== null && autoMergeMin !== undefined) body.autoMergeMinutes = Number(autoMergeMin) || 0
        return postJson(API + '/sync/config', body)
          .then(function (d) {
            if (!d || !d.ok) throw new Error((d && d.error) || '存不进去')
            setSyncToken('')
            return load()
          })
          .then(function () {
            flash('同步设置存好了')
          })
          .catch(function (e) {
            setError(String(e && e.message ? e.message : e))
          })
          .then(function () {
            setBusy(false)
          })
      }

      function ingestNow() {
        return run(postJson(API + '/ingest', {}), '整理完了')
      }

      function refreshProfileNow() {
        return run(postJson(API + '/profile', {}), '画像刷新了')
      }

      function deleteJournal(id) {
        return run(postJson(API + '/journal/delete', { id: id }), '删掉了')
      }

      function tryRecall() {
        setBusy(true)
        getJson(API + '/recall?q=' + encodeURIComponent(recallQuery))
          .then(function (d) {
            if (!d || !d.ok) throw new Error((d && d.error) || '试不出来')
            setTrace(d.trace)
          })
          .catch(function (e) {
            setError(String(e && e.message ? e.message : e))
          })
          .then(function () {
            setBusy(false)
          })
      }

      function loadRecallLast() {
        return getJson(API + '/recall/last').then(function (d) {
          if (d && d.trace) setTrace(d.trace)
          else flash('还没有召回记录')
        })
      }

      function saveWeights() {
        return save(
          {
            memory: {
              weights: { relevance: wRelevance / 100, importance: wImportance / 100, recency: wRecency / 100 },
              injectMax: injectMax,
            },
          },
          '权重已保存',
        )
      }

      function saveDiaryMinutes() {
        return save({ memory: { diary: { everyMinutes: diaryMinutes } } }, '间隔改成 ' + perMin(diaryMinutes))
      }

      function saveReviewDays() {
        return save({ memory: { review: { everyDays: reviewDays } } }, '复盘间隔改成 ' + reviewDays + ' 天')
      }

      function writeNow(path, okText) {
        setWriting(true)
        setError('')
        postJson(API + path, {})
          .then(function (d) {
            if (!d || !d.ok) throw new Error((d && d.error) || '没写成')
            return load()
          })
          .then(function () {
            flash(okText)
          })
          .catch(function (e) {
            setError(String(e && e.message ? e.message : e))
          })
          .then(function () {
            setWriting(false)
          })
      }

      function decayNow() {
        run(postJson(API + '/memory/decay', {}), '归档跑完了')
      }

      function healthNow() {
        setBusy(true)
        setError('')
        getJson(API + '/memory/health')
          .then(function (d) {
            if (!d || !d.ok) throw new Error((d && d.error) || '体检失败')
            setHealth(d)
            flash('体检完了')
          })
          .catch(function (e) {
            setError(String(e && e.message ? e.message : e))
          })
          .then(function () {
            setBusy(false)
          })
      }

      if (!status) {
        return h('div', { 'data-wk': '' }, h('div', { 'data-wk-hint': '' }, error ? '读取失败：' + error : '鲸核 读取中…'))
      }

      var mem = status.memory || {}
      var shared = {
        status: status,
        memory: mem,
        enabled: Boolean(status.enabled),
        kernelChars: status.kernelChars || 0,
        sections: sections,
        updateSection: updateSection,
        addSection: addSection,
        removeSection: removeSection,
        moveSection: moveSection,
        toggleSection: toggleSection,
        saveKernel: saveKernel,
        kernelDirty: JSON.stringify(sections) !== JSON.stringify(savedSections),
        personas: personas,
        kernelName: kernelName,
        sessions: sessions,
        boundSessions: boundSessions,
        archivedCount: archivedCount,
        bindPersona: bindPersona,
        reloadSessions: reloadSessions,
        editId: editId,
        activeId: activeId,
        activeName: activeName,
        personaName: personaName,
        setPersonaName: setPersonaName,
        delAsk: delAsk,
        selectPersona: selectPersona,
        createPersona: createPersona,
        renamePersona: renamePersona,
        makeDefault: makeDefault,
        deletePersona: deletePersona,
        mood: status.mood || { emotion: '平静', intensity: 0.5, base: 0.5, hours: 0, band: '有感觉', level: 5 },
        affinity: status.affinity || { value: 45, stage: '平常', auto: true, msgCount: 0, stages: [] },
        dice: status.dice || { enabled: true, everyMinutes: 45, sides: 6, lastAt: 0, lastRoll: 0, lastEmotion: '', pct: {}, history: [] },
        meme: status.meme || { enabled: true, emotion: '平静', tag: 'daily', tags: [] },
        setMood: setMood,
        setAffinity: setAffinity,
        setInterest: setInterest,
        rollDice: rollDice,
        saveStyle: saveStyle,
        memText: memText,
        setMemText: setMemText,
        memKind: memKind,
        setMemKind: setMemKind,
        memLane: memLane,
        setMemLane: setMemLane,
        laneFilter: laneFilter,
        setLaneFilter: setLaneFilter,
        tierFilter: tierFilter,
        setTierFilter: setTierFilter,
        listCap: listCap,
        setListCap: setListCap,
        sync: status.sync || { lastExportAt: 0, lastImportAt: 0, lastBackupAt: 0, backupEveryHours: 12, keepBackups: 7, backups: [], dir: '', fileHint: '', format: '', pluginVersion: '' },
        exportNow: exportNow,
        pickImport: pickImport,
        importFile: importFile,
        importMode: importMode,
        setImportMode: setImportMode,
        health: health,
        decayNow: decayNow,
        healthNow: healthNow,
        autoEvery: autoEvery,
        setAutoEvery: setAutoEvery,
        autoMemoryNow: autoMemoryNow,
        memWeight: memWeight,
        setMemWeight: setMemWeight,
        items: items,
        setWeight: setWeight,
        editMemory: editMemory,
        restoreMemory: restoreMemory,
        pickEdgeNow: pickEdgeNow,
        clearEdgeNow: clearEdgeNow,
        backupNow: backupNow,
        gh: (status.sync && status.sync.gh) || {},
        syncRepo: syncRepo,
        setSyncRepo: setSyncRepo,
        syncToken: syncToken,
        setSyncToken: setSyncToken,
        autoUpMin: autoUpMin,
        setAutoUpMin: setAutoUpMin,
        autoMergeMin: autoMergeMin,
        setAutoMergeMin: setAutoMergeMin,
        syncMerge: syncMerge,
        toggleBootMerge: toggleBootMerge,
        syncVerify: syncVerify,
        syncCreateRepo: syncCreateRepo,
        syncUpload: syncUpload,
        syncPull: syncPull,
        syncSave: syncSave,
        ingestNow: ingestNow,
        refreshProfileNow: refreshProfileNow,
        deleteMemory: deleteMemory,
        journal: journal,
        deleteJournal: deleteJournal,
        trace: trace,
        recallQuery: recallQuery,
        setRecallQuery: setRecallQuery,
        tryRecall: tryRecall,
        loadRecallLast: loadRecallLast,
        wRelevance: wRelevance,
        setWRelevance: setWRelevance,
        wImportance: wImportance,
        setWImportance: setWImportance,
        wRecency: wRecency,
        setWRecency: setWRecency,
        injectMax: injectMax,
        setInjectMax: setInjectMax,
        saveWeights: saveWeights,
        diaryMinutes: diaryMinutes,
        setDiaryMinutes: setDiaryMinutes,
        reviewDays: reviewDays,
        setReviewDays: setReviewDays,
        saveDiaryMinutes: saveDiaryMinutes,
        saveReviewDays: saveReviewDays,
        writeDiary: function () {
          writeNow('/diary/now', '写完一篇')
        },
        writeReview: function () {
          writeNow('/review/now', '复盘写好了')
        },
        writing: writing,
        addMemory: addMemory,
        save: save,
        busy: busy,
      }

      var pane = h(KernelPane, shared)
      if (tab === 'mood') pane = h(MoodPane, shared)
      else if (tab === 'memory') pane = h(MemoryPane, shared)
      else if (tab === 'diary') pane = h(DiaryPane, shared)
      else if (tab === 'status') pane = h(StatusPane, shared)
      if (PaneBoundary) pane = h(PaneBoundary, { key: tab, children: pane })

      return h(
        'div',
        { 'data-wk': '' },
        h(
          'div',
          { 'data-wk-head': '' },
          h('i', { 'data-wk-dot': status.enabled ? '' : 'off' }),
          h('span', { 'data-wk-name': '' }, '鲸核'),
          h('span', { 'data-wk-sub': '' }, 'v' + (status.version || '0.3.0') + ' · 人设 / 心情 / 记忆 / 日记'),
          h('span', { 'data-wk-spacer': '' }),
          h('span', { 'data-wk-hint': '' }, status.enabled ? '运行中' : '已停用'),
        ),

        error ? h('div', { 'data-wk-err': '' }, error) : null,
        notice ? h('div', { 'data-wk-ok': '' }, notice) : null,
        !mem.enabled ? h('div', { 'data-wk-hint': '' }, '记忆是关着的 —— 不记也不想起来。') : null,

        h(
          'div',
          { 'data-wk-tabs': '' },
          TABS.map(function (t) {
            return h(
              'button',
              {
                key: t.id,
                'data-wk-tab': '',
                'data-on': tab === t.id ? '' : undefined,
                onClick: function () {
                  setTab(t.id)
                  try {
                    localStorage.setItem(TAB_KEY, t.id)
                  } catch (e) {}
                },
              },
              t.label,
            )
          }),
        ),

        pane,
      )
    }

    function apply(ctx) {
      ctx.effect(function () {
        var id = 'dsh-whale-core-styles'
        if (document.getElementById(id) === null) {
          var style = document.createElement('style')
          style.id = id
          style.textContent = CSS
          document.head.appendChild(style)
        }
        return function () {
          var el = document.getElementById(id)
          if (el !== null && el.parentNode !== null) el.parentNode.removeChild(el)
        }
      }, 'whale-core: styles')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'whale-core',
            order: 47,
            locale: 'zh-CN',
            label: function () {
              return '鲸核'
            },
          },
          function (props) {
            return h(Panel, props || {})
          },
        )
      })
    }

    return { name: 'whale-core', inject: ['slots'], apply: apply }
  },
})
