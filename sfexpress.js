/**
 * 顺丰速运 - 抓会话 + 签到 / 每日任务（同一脚本）
 *
 * 双模式：
 * 1) Rewrite / http-request：抓取 universalSign → 存 chavy_login_sfexpress
 * 2) Cron / 手动运行：用已存会话换 Cookie 并签到、做任务
 *
 * [mitm]
 * hostname = ccsp-egmas.sf-express.com, mcs-mimp-web.sf-express.com
 *
 * [rewrite_local]
 * ^https:\/\/ccsp-egmas\.sf-express\.com\/cx-app-member\/member\/app\/user\/universalSign url script-request-body sfexpress/sfexpress.js
 *
 * [task_local]
 * 4 0 * * * sfexpress/sfexpress.js, tag=顺丰速运, enabled=true
 *
 * Surge:
 * sfexpress_cookie = type=http-request,pattern=^https:\/\/ccsp-egmas\.sf-express\.com\/cx-app-member\/member\/app\/user\/universalSign,requires-body=1,script-path=sfexpress.js
 * sfexpress_cron = type=cron,cronexp=4 0 * * *,script-path=sfexpress.js
 */

const $ = new Env('顺丰速运')
$.KEY_login = 'chavy_login_sfexpress'

const SF = {
  signSecret: 'wwesldfs29aniversaryvdld29',
  sysCode: 'MCS-MIMP-CORE',
  platform: 'SFAPP',
  channel: 'autoappmy',
  ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 mediaCode=SFEXPRESSAPP-iOS-ML',
  activityRedirect: 'https://mcs-mimp-web.sf-express.com/mcs-mimp/share/app/activityRedirect',
  sign: 'https://mcs-mimp-web.sf-express.com/mcs-mimp/commonPost/~memberNonactivity~integralSignV2Service~sign',
  todaySign: 'https://mcs-mimp-web.sf-express.com/mcs-mimp/commonPost/~memberNonactivity~integralSignV2Service~getTodaySign',
  ifLogin: 'https://mcs-mimp-web.sf-express.com/mcs-mimp/ifLogin',
  queryTasks: 'https://mcs-mimp-web.sf-express.com/mcs-mimp/commonPost/~memberNonactivity~integralTaskStrategyService~queryPointTaskAndSignFromES',
  finishTask: 'https://mcs-mimp-web.sf-express.com/mcs-mimp/commonRoutePost/memberEs/taskRecord/finishTask',
  fetchIntegral: 'https://mcs-mimp-web.sf-express.com/mcs-mimp/commonPost/~memberNonactivity~integralTaskStrategyService~fetchIntegral'
}

const SKIP_TASK_TITLES = ['用行业模板寄件下单', '去新增一个收件偏好', '参与积分活动', '查看限时储值优惠']

!(async () => {
  // Rewrite / http-request 场景：只抓会话
  if (typeof $request !== 'undefined' && $request && $request.url) {
    await captureCookie()
    return
  }
  // Cron / 手动：签到流程
  await loginapp()
  if (!$.login || !$.login.success || !$.login.obj || !$.login.obj.sign) {
    throw new Error('universalSign 失败，请重新打开 App 会员页抓取会话')
  }
  await $.wait(800)
  await loginweb()
  if (!$.cookie) {
    throw new Error('activityRedirect 未拿到 Cookie')
  }
  await $.wait(500)
  await checkLogin()
  await $.wait(500)
  await getTodaySign()
  await $.wait(500)
  await sign()
  await $.wait(800)
  await signDailyTasks()
  showmsg()
})()
  .catch((e) => {
    $.subt = `失败: ${e.message || e}`
    $.desc = [String(e.stack || e)]
    $.msg($.name, $.subt, $.desc.join('\n'))
    $.logErr(e)
  })
  .finally(() => $.done())

/** Rewrite：保存 App universalSign 请求 */
function captureCookie() {
  const url = $request.url || ''
  if (!/universalSign/.test(url)) {
    $.msg($.name, '跳过', '非 universalSign 请求')
    return Promise.resolve()
  }
  const session = {
    url,
    body: $request.body,
    headers: normalizeReqHeaders($request.headers)
  }
  ;['Content-Length', 'content-length', 'Accept-Encoding', 'accept-encoding'].forEach((k) => {
    delete session.headers[k]
  })
  console.log(JSON.stringify(session))
  if ($.setdata(JSON.stringify(session), $.KEY_login)) {
    $.msg($.name, '获取会话: 成功', '已保存 universalSign，可运行签到任务')
  } else {
    $.msg($.name, '获取会话: 失败', '写入持久化失败')
  }
  return Promise.resolve()
}

function normalizeReqHeaders(h) {
  const out = {}
  if (!h) return out
  for (const k of Object.keys(h)) {
    if (k.startsWith(':')) continue
    out[k] = h[k]
  }
  return out
}

function loginapp() {
  const loginOpts = $.getjson($.KEY_login)
  if (!loginOpts || !loginOpts.url) {
    return Promise.reject(new Error('未找到会话 chavy_login_sfexpress，请先用本脚本做 Rewrite 抓取'))
  }
  // 兼容旧抓包字段；去掉过期 Cookie，保留 token / requestSign 等
  loginOpts.headers = loginOpts.headers || {}
  delete loginOpts.headers.Cookie
  delete loginOpts.headers.cookie
  // 旧脚本可能抓到过期路径，强制打到当前 universalSign
  if (!/universalSign/.test(loginOpts.url)) {
    loginOpts.url = 'https://ccsp-egmas.sf-express.com/cx-app-member/member/app/user/universalSign'
  }
  $.deviceId =
    loginOpts.headers.deviceId ||
    loginOpts.headers.DeviceId ||
    loginOpts.headers['srcDeviceGuid'] ||
    randomDeviceId()

  return $.http.post(loginOpts).then((resp) => {
    $.login = safeJson(resp.body)
    $.log(`universalSign: success=${$.login && $.login.success}`)
  })
}

function loginweb() {
  const sign = encodeURIComponent($.login.obj.sign)
  const bizCode = encodeURIComponent(
    JSON.stringify({
      path: '/up-member/newHome',
      autoSignIn: '1',
      supportShare: 'YES',
      tab: '2',
      from: SF.channel
    })
  )
  const opts = {
    url: `${SF.activityRedirect}?sign=${sign}&source=SFAPP&bizCode=${bizCode}`,
    headers: {
      'User-Agent': SF.ua,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    // QuanX: 不自动跟随，便于拿到 302 Set-Cookie
    opts: { redirection: false }
  }

  return $.http.get(opts).then((resp) => {
    $.cookie = mergeCookies($.cookie, resp.headers)
    // 若客户端已跟随重定向且头上没有 cookie，再从 Location 页补一次
    if (!$.cookie && resp.headers) {
      const loc = headerGet(resp.headers, 'Location') || headerGet(resp.headers, 'location')
      if (loc) {
        return $.http
          .get({
            url: loc,
            headers: { 'User-Agent': SF.ua },
            opts: { redirection: false }
          })
          .then((r2) => {
            $.cookie = mergeCookies($.cookie, r2.headers)
            $.log(`activityRedirect cookies: ${maskCookie($.cookie)}`)
          })
      }
    }
    $.log(`activityRedirect cookies: ${maskCookie($.cookie)}`)
  })
}

function checkLogin() {
  return h5Post(SF.ifLogin, {}).then((data) => {
    $.ifLogin = data
    const st = data && data.obj && data.obj.loginStatus
    $.log(`ifLogin: loginStatus=${st}`)
    if (st !== 1) throw new Error('H5 未登录，Cookie 无效')
  })
}

function getTodaySign() {
  return h5Post(SF.todaySign, {}).then((data) => {
    $.today = data
    if (data && data.obj) {
      $.log(`getTodaySign: signed=${data.obj.signed}, dayCount=${data.obj.dayCount}`)
    }
  })
}

function sign() {
  // 已签则跳过实际签到，仍保留结果用于通知
  if ($.today && $.today.obj && $.today.obj.signed) {
    $.sign = {
      success: true,
      obj: {
        signed: true,
        already: true,
        dayCount: $.today.obj.dayCount
      }
    }
    return Promise.resolve()
  }
  return h5Post(SF.sign, {}).then((data) => {
    $.sign = data
  })
}

function queryDailyTask() {
  return h5Post(SF.queryTasks, {
    channelType: '1',
    deviceId: ($.deviceId || randomDeviceId()).slice(0, 18)
  }).then((data) => {
    $.tasks = (data && data.obj && data.obj.taskTitleLevels) || []
    $.totalPoint = data && data.obj && data.obj.totalPoint
  })
}

async function signDailyTasks() {
  await queryDailyTask()
  for (let i = 0; i < $.tasks.length; i++) {
    const task = $.tasks[i]
    if (SKIP_TASK_TITLES.includes(task.title)) {
      task.result = '跳过'
      continue
    }
    if (task.status === 3) {
      task.result = '积分已领取'
      continue
    }
    if (task.status === 2) {
      await doTask(task)
      await $.wait(600)
      await getPoint(task)
    } else if (task.status === 1) {
      await getPoint(task)
    } else {
      task.result = `未知状态(${task.status})`
    }
    await $.wait(500)
  }
}

function doTask(task) {
  return h5Post(SF.finishTask, { taskCode: task.taskCode }).then((data) => {
    task.finish = data
  })
}

function getPoint(task) {
  return h5Post(SF.fetchIntegral, {
    strategyId: task.strategyId,
    taskId: task.taskId,
    taskCode: task.taskCode,
    channelType: '1'
  }).then((data) => {
    task.result = data && data.success ? '成功' : (data && data.errorMessage) || '失败'
  })
}

function showmsg() {
  const ok = $.sign && $.sign.success
  const obj = ($.sign && $.sign.obj) || {}
  $.subt = '签到: '
  $.desc = []

  if (ok) {
    if (obj.already || ($.today && $.today.obj && $.today.obj.signed && obj.already !== false && !obj.award)) {
      // already 分支或签到后无 award（部分重复场景）
      if (obj.already) {
        $.subt += '已签到'
      } else if (obj.award) {
        $.subt += '成功'
      } else {
        $.subt += obj.signed ? '成功' : '完成'
      }
    } else if (obj.award) {
      $.subt += '成功'
    } else {
      $.subt += obj.signed ? '成功' : '完成'
    }
    const day = obj.dayCount || ($.today && $.today.obj && $.today.obj.dayCount) || '-'
    $.desc.push(`连续签到: ${day} 天`)
    if (obj.award && obj.award.productDTOList) {
      const gifts = obj.award.productDTOList.map((p) => p.productName).join('、')
      $.desc.push(`奖励: ${gifts}`)
    } else if (obj.awardNum) {
      $.desc.push(`奖励积分: ${obj.awardNum}`)
    }
  } else {
    $.subt += '失败'
    $.desc.push(`说明: ${($.sign && ($.sign.errorMessage || $.sign.message)) || '未知错误'}`)
  }

  if ($.totalPoint != null) $.desc.push(`当前积分: ${$.totalPoint}`)
  $.desc.push('', '每日任务:')
  for (const task of $.tasks || []) {
    $.desc.push(`${task.title}: ${task.result || '-'}`)
  }
  $.msg($.name, $.subt, $.desc.join('\n'))
}

/** ---------- H5 helpers ---------- */

function h5Post(url, body) {
  const headers = buildH5Headers()
  return $.http
    .post({
      url,
      body: JSON.stringify(body == null ? {} : body),
      headers
    })
    .then((resp) => {
      // 部分环境会在业务响应里续 Cookie
      $.cookie = mergeCookies($.cookie, resp.headers) || $.cookie
      return safeJson(resp.body)
    })
}

function buildH5Headers() {
  const timestamp = String(Date.now())
  const signature = md5(`token=${SF.signSecret}&timestamp=${timestamp}&sysCode=${SF.sysCode}`)
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'User-Agent': SF.ua,
    Origin: 'https://mcs-mimp-web.sf-express.com',
    Referer: 'https://mcs-mimp-web.sf-express.com/up-member/newHome',
    platform: SF.platform,
    channel: SF.channel,
    sysCode: SF.sysCode,
    timestamp,
    signature,
    deviceId: $.deviceId || randomDeviceId(),
    Cookie: $.cookie || ''
  }
}

function safeJson(text) {
  try {
    return typeof text === 'object' ? text : JSON.parse(text)
  } catch (e) {
    return { success: false, errorMessage: String(text).slice(0, 200) }
  }
}

function headerGet(headers, name) {
  if (!headers) return ''
  if (headers[name] != null) return headers[name]
  const lower = name.toLowerCase()
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k]
  }
  return ''
}

function mergeCookies(prev, headers) {
  const setCookie = headerGet(headers, 'Set-Cookie') || headerGet(headers, 'set-cookie')
  if (!setCookie) return prev || ''
  const bag = cookieToMap(prev)
  const parts = Array.isArray(setCookie) ? setCookie : String(setCookie).split(/,(?=\s*[^;=]+=)/)
  for (const raw of parts) {
    const kv = String(raw).split(';')[0]
    const i = kv.indexOf('=')
    if (i > 0) bag[kv.slice(0, i).trim()] = kv.slice(i + 1).trim()
  }
  return Object.keys(bag)
    .map((k) => `${k}=${bag[k]}`)
    .join('; ')
}

function cookieToMap(cookie) {
  const bag = {}
  if (!cookie) return bag
  for (const item of String(cookie).split(';')) {
    const i = item.indexOf('=')
    if (i > 0) bag[item.slice(0, i).trim()] = item.slice(i + 1).trim()
  }
  return bag
}

function maskCookie(c) {
  if (!c) return '(empty)'
  const m = cookieToMap(c)
  const keys = Object.keys(m)
  const keep = ['_login_user_id_', '_login_mobile_', 'sessionId', 'JSESSIONID'].filter((k) => m[k])
  return `${keep.map((k) => `${k}=***`).join('; ') || 'keys=' + keys.join(',')}`
}

function randomDeviceId() {
  const hex = 'abcdef0123456789'
  let s = ''
  for (let i = 0; i < 16; i++) s += hex[Math.floor(Math.random() * hex.length)]
  return s
}

/** 精简 MD5，供 QuanX/Surge/Loon 无 crypto 环境使用 */
function md5(string) {
  function cmn(q, a, b, x, s, t) {
    a = add32(add32(a, q), add32(x, t))
    return add32((a << s) | (a >>> (32 - s)), b)
  }
  function ff(a, b, c, d, x, s, t) {
    return cmn((b & c) | (~b & d), a, b, x, s, t)
  }
  function gg(a, b, c, d, x, s, t) {
    return cmn((b & d) | (c & ~d), a, b, x, s, t)
  }
  function hh(a, b, c, d, x, s, t) {
    return cmn(b ^ c ^ d, a, b, x, s, t)
  }
  function ii(a, b, c, d, x, s, t) {
    return cmn(c ^ (b | ~d), a, b, x, s, t)
  }
  function md5cycle(x, k) {
    let a = x[0],
      b = x[1],
      c = x[2],
      d = x[3]
    a = ff(a, b, c, d, k[0], 7, -680876936)
    d = ff(d, a, b, c, k[1], 12, -389564586)
    c = ff(c, d, a, b, k[2], 17, 606105819)
    b = ff(b, c, d, a, k[3], 22, -1044525330)
    a = ff(a, b, c, d, k[4], 7, -176418897)
    d = ff(d, a, b, c, k[5], 12, 1200080426)
    c = ff(c, d, a, b, k[6], 17, -1473231341)
    b = ff(b, c, d, a, k[7], 22, -45705983)
    a = ff(a, b, c, d, k[8], 7, 1770035416)
    d = ff(d, a, b, c, k[9], 12, -1958414417)
    c = ff(c, d, a, b, k[10], 17, -42063)
    b = ff(b, c, d, a, k[11], 22, -1990404162)
    a = ff(a, b, c, d, k[12], 7, 1804603682)
    d = ff(d, a, b, c, k[13], 12, -40341101)
    c = ff(c, d, a, b, k[14], 17, -1502002290)
    b = ff(b, c, d, a, k[15], 22, 1236535329)
    a = gg(a, b, c, d, k[1], 5, -165796510)
    d = gg(d, a, b, c, k[6], 9, -1069501632)
    c = gg(c, d, a, b, k[11], 14, 643717713)
    b = gg(b, c, d, a, k[0], 20, -373897302)
    a = gg(a, b, c, d, k[5], 5, -701558691)
    d = gg(d, a, b, c, k[10], 9, 38016083)
    c = gg(c, d, a, b, k[15], 14, -660478335)
    b = gg(b, c, d, a, k[4], 20, -405537848)
    a = gg(a, b, c, d, k[9], 5, 568446438)
    d = gg(d, a, b, c, k[14], 9, -1019803690)
    c = gg(c, d, a, b, k[3], 14, -187363961)
    b = gg(b, c, d, a, k[8], 20, 1163531501)
    a = gg(a, b, c, d, k[13], 5, -1444681467)
    d = gg(d, a, b, c, k[2], 9, -51403784)
    c = gg(c, d, a, b, k[7], 14, 1735328473)
    b = gg(b, c, d, a, k[12], 20, -1926607734)
    a = hh(a, b, c, d, k[5], 4, -378558)
    d = hh(d, a, b, c, k[8], 11, -2022574463)
    c = hh(c, d, a, b, k[11], 16, 1839030562)
    b = hh(b, c, d, a, k[14], 23, -35309556)
    a = hh(a, b, c, d, k[1], 4, -1530992060)
    d = hh(d, a, b, c, k[4], 11, 1272893353)
    c = hh(c, d, a, b, k[7], 16, -155497632)
    b = hh(b, c, d, a, k[10], 23, -1094730640)
    a = hh(a, b, c, d, k[13], 4, 681279174)
    d = hh(d, a, b, c, k[0], 11, -358537222)
    c = hh(c, d, a, b, k[3], 16, -722521979)
    b = hh(b, c, d, a, k[6], 23, 76029189)
    a = hh(a, b, c, d, k[9], 4, -640364487)
    d = hh(d, a, b, c, k[12], 11, -421815835)
    c = hh(c, d, a, b, k[15], 16, 530742520)
    b = hh(b, c, d, a, k[2], 23, -995338651)
    a = ii(a, b, c, d, k[0], 6, -198630844)
    d = ii(d, a, b, c, k[7], 10, 1126891415)
    c = ii(c, d, a, b, k[14], 15, -1416354905)
    b = ii(b, c, d, a, k[5], 21, -57434055)
    a = ii(a, b, c, d, k[12], 6, 1700485571)
    d = ii(d, a, b, c, k[3], 10, -1894986606)
    c = ii(c, d, a, b, k[10], 15, -1051523)
    b = ii(b, c, d, a, k[1], 21, -2054922799)
    a = ii(a, b, c, d, k[8], 6, 1873313359)
    d = ii(d, a, b, c, k[15], 10, -30611744)
    c = ii(c, d, a, b, k[6], 15, -1560198380)
    b = ii(b, c, d, a, k[13], 21, 1309151649)
    a = ii(a, b, c, d, k[4], 6, -145523070)
    d = ii(d, a, b, c, k[11], 10, -1120210379)
    c = ii(c, d, a, b, k[2], 15, 718787259)
    b = ii(b, c, d, a, k[9], 21, -343485551)
    x[0] = add32(a, x[0])
    x[1] = add32(b, x[1])
    x[2] = add32(c, x[2])
    x[3] = add32(d, x[3])
  }
  function md5blk(s) {
    const md5blks = []
    for (let i = 0; i < 64; i += 4) {
      md5blks[i >> 2] =
        s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24)
    }
    return md5blks
  }
  function md51(s) {
    const n = s.length
    const state = [1732584193, -271733879, -1732584194, 271733878]
    let i
    for (i = 64; i <= n; i += 64) md5cycle(state, md5blk(s.substring(i - 64, i)))
    s = s.substring(i - 64)
    const tail = new Array(16).fill(0)
    for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << (i % 4 << 3)
    tail[i >> 2] |= 0x80 << (i % 4 << 3)
    if (i > 55) {
      md5cycle(state, tail)
      for (let j = 0; j < 16; j++) tail[j] = 0
    }
    tail[14] = n * 8
    md5cycle(state, tail)
    return state
  }
  function rhex(n) {
    const hex_chr = '0123456789abcdef'
    let s = ''
    for (let j = 0; j < 4; j++) s += hex_chr[(n >> (j * 8 + 4)) & 0x0f] + hex_chr[(n >> (j * 8)) & 0x0f]
    return s
  }
  function add32(a, b) {
    return (a + b) & 0xffffffff
  }
  // UTF-8
  string = unescape(encodeURIComponent(string))
  return md51(string).map(rhex).join('')
}

// prettier-ignore
function Env(t,e){class s{constructor(t){this.env=t}send(t,e="GET"){t="string"==typeof t?{url:t}:t;let s=this.get;return"POST"===e&&(s=this.post),new Promise((e,i)=>{s.call(this,t,(t,s,r)=>{t?i(t):e(s)})})}get(t){return this.send.call(this.env,t)}post(t){return this.send.call(this.env,t,"POST")}}return new class{constructor(t,e){this.name=t,this.http=new s(this),this.data=null,this.dataFile="box.dat",this.logs=[],this.isMute=!1,this.isNeedRewrite=!1,this.logSeparator="\n",this.startTime=(new Date).getTime(),Object.assign(this,e),this.log("",`🔔${this.name}, 开始!`)}isNode(){return"undefined"!=typeof module&&!!module.exports}isQuanX(){return"undefined"!=typeof $task}isSurge(){return"undefined"!=typeof $httpClient&&"undefined"==typeof $loon}isLoon(){return"undefined"!=typeof $loon}isShadowrocket(){return"undefined"!=typeof $rocket}toObj(t,e=null){try{return JSON.parse(t)}catch{return e}}toStr(t,e=null){try{return JSON.stringify(t)}catch{return e}}getjson(t,e){let s=e;const i=this.getdata(t);if(i)try{s=JSON.parse(this.getdata(t))}catch{}return s}setjson(t,e){try{return this.setdata(JSON.stringify(t),e)}catch{return!1}}getScript(t){return new Promise(e=>{this.get({url:t},(t,s,i)=>e(i))})}runScript(t,e){return new Promise(s=>{let i=this.getdata("@chavy_boxjs_userCfgs.httpapi");i=i?i.replace(/\n/g,"").trim():i;let r=this.getdata("@chavy_boxjs_userCfgs.httpapi_timeout");r=r?1*r:20,r=e&&e.timeout?e.timeout:r;const[o,h]=i.split("@"),a={url:`http://${h}/v1/scripting/evaluate`,body:{script_text:t,mock_type:"cron",timeout:r},headers:{"X-Key":o,Accept:"*/*"}};this.post(a,(t,e,i)=>s(i))}).catch(t=>this.logErr(t))}loaddata(){if(!this.isNode())return{};{this.fs=this.fs?this.fs:require("fs"),this.path=this.path?this.path:require("path");const t=this.path.resolve(this.dataFile),e=this.path.resolve(process.cwd(),this.dataFile),s=this.fs.existsSync(t),i=!s&&this.fs.existsSync(e);if(!s&&!i)return{};{const i=s?t:e;try{return JSON.parse(this.fs.readFileSync(i))}catch(t){return{}}}}}writedata(){if(this.isNode()){this.fs=this.fs?this.fs:require("fs"),this.path=this.path?this.path:require("path");const t=this.path.resolve(this.dataFile),e=this.path.resolve(process.cwd(),this.dataFile),s=this.fs.existsSync(t),i=!s&&this.fs.existsSync(e),r=JSON.stringify(this.data);s?this.fs.writeFileSync(t,r):i?this.fs.writeFileSync(e,r):this.fs.writeFileSync(t,r)}}lodash_get(t,e,s){const i=e.replace(/\[(\d+)\]/g,".$1").split(".");let r=t;for(const t of i)if(r=Object(r)[t],void 0===r)return s;return r}lodash_set(t,e,s){return Object(t)!==t?t:(Array.isArray(e)||(e=e.toString().match(/[^.[\]]+/g)||[]),e.slice(0,-1).reduce((t,s,i)=>Object(t[s])===t[s]?t[s]:t[s]=Math.abs(e[i+1])>>0==+e[i+1]?[]:{},t)[e[e.length-1]]=s,t)}getdata(t){let e=this.getval(t);if(/^@/.test(t)){const[,s,i]=/^@(.*?)\.(.*?)$/.exec(t),r=s?this.getval(s):"";if(r)try{const t=JSON.parse(r);e=t?this.lodash_get(t,i,""):e}catch(t){e=""}}return e}setdata(t,e){let s=!1;if(/^@/.test(e)){const[,i,r]=/^@(.*?)\.(.*?)$/.exec(e),o=this.getval(i),h=i?"null"===o?null:o||"{}":"{}";try{const e=JSON.parse(h);this.lodash_set(e,r,t),s=this.setval(JSON.stringify(e),i)}catch(e){const o={};this.lodash_set(o,r,t),s=this.setval(JSON.stringify(o),i)}}else s=this.setval(t,e);return s}getval(t){return this.isSurge()||this.isLoon()?$persistentStore.read(t):this.isQuanX()?$prefs.valueForKey(t):this.isNode()?(this.data=this.loaddata(),this.data[t]):this.data&&this.data[t]||null}setval(t,e){return this.isSurge()||this.isLoon()?$persistentStore.write(t,e):this.isQuanX()?$prefs.setValueForKey(t,e):this.isNode()?(this.data=this.loaddata(),this.data[e]=t,this.writedata(),!0):this.data&&this.data[e]||null}initGotEnv(t){this.got=this.got?this.got:require("got"),this.cktough=this.cktough?this.cktough:require("tough-cookie"),this.ckjar=this.ckjar?this.ckjar:new this.cktough.CookieJar,t&&(t.headers=t.headers?t.headers:{},void 0===t.headers.Cookie&&void 0===t.cookieJar&&(t.cookieJar=this.ckjar))}get(t,e=(()=>{})){t.headers&&(delete t.headers["Content-Type"],delete t.headers["Content-Length"]),this.isSurge()||this.isLoon()?(this.isSurge()&&this.isNeedRewrite&&(t.headers=t.headers||{},Object.assign(t.headers,{"X-Surge-Skip-Scripting":!1})),$httpClient.get(t,(t,s,i)=>{!t&&s&&(s.body=i,s.statusCode=s.status,s.headers=s.headers||{}),e(t,s,i)})):this.isQuanX()?(this.isNeedRewrite&&(t.opts=t.opts||{},Object.assign(t.opts,{hints:!1})),$task.fetch(t).then(t=>{const{statusCode:s,statusCode:i,headers:r,body:o}=t;e(null,{status:s,statusCode:i,headers:r,body:o},o)},t=>e(t))):this.isNode()&&(this.initGotEnv(t),this.got(t).on("redirect",(t,e)=>{try{if(t.headers["set-cookie"]){const s=t.headers["set-cookie"].map(this.cktough.Cookie.parse).toString();s&&this.ckjar.setCookieSync(s,null),e.cookieJar=this.ckjar}}catch(t){this.logErr(t)}}).then(t=>{const{statusCode:s,statusCode:i,headers:r,body:o}=t;e(null,{status:s,statusCode:i,headers:r,body:o},o)},t=>{const{message:s,response:i}=t;e(s,i,i&&i.body)}))}post(t,e=(()=>{})){const s=t.method?t.method.toLocaleLowerCase():"post";if(t.body&&t.headers&&!t.headers["Content-Type"]&&(t.headers["Content-Type"]="application/x-www-form-urlencoded"),t.headers&&delete t.headers["Content-Length"],this.isSurge()||this.isLoon())this.isSurge()&&this.isNeedRewrite&&(t.headers=t.headers||{},Object.assign(t.headers,{"X-Surge-Skip-Scripting":!1})),$httpClient[s](t,(t,s,i)=>{!t&&s&&(s.body=i,s.statusCode=s.status,s.headers=s.headers||{}),e(t,s,i)});else if(this.isQuanX())t.method=s,this.isNeedRewrite&&(t.opts=t.opts||{},Object.assign(t.opts,{hints:!1})),$task.fetch(t).then(t=>{const{statusCode:s,statusCode:i,headers:r,body:o}=t;e(null,{status:s,statusCode:i,headers:r,body:o},o)},t=>e(t));else if(this.isNode()){this.initGotEnv(t);const{url:i,...r}=t;this.got[s](i,r).then(t=>{const{statusCode:s,statusCode:i,headers:r,body:o}=t;e(null,{status:s,statusCode:i,headers:r,body:o},o)},t=>{const{message:s,response:i}=t;e(s,i,i&&i.body)})}}time(t,e=null){const s=e?new Date(e):new Date;let i={"M+":s.getMonth()+1,"d+":s.getDate(),"H+":s.getHours(),"m+":s.getMinutes(),"s+":s.getSeconds(),"q+":Math.floor((s.getMonth()+3)/3),S:s.getMilliseconds()};/(y+)/.test(t)&&(t=t.replace(RegExp.$1,(s.getFullYear()+"").substr(4-RegExp.$1.length)));for(let e in i)new RegExp("("+e+")").test(t)&&(t=t.replace(RegExp.$1,1==RegExp.$1.length?i[e]:("00"+i[e]).substr((""+i[e]).length)));return t}msg(e=t,s="",i="",r){const o=t=>{if(!t)return t;if("string"==typeof t)return this.isLoon()?t:this.isQuanX()?{"open-url":t}:this.isSurge()?{url:t}:void 0;if("object"==typeof t){if(this.isLoon()){let e=t.openUrl||t.url||t["open-url"],s=t.mediaUrl||t["media-url"];return{openUrl:e,mediaUrl:s}}if(this.isQuanX()){let e=t["open-url"]||t.url||t.openUrl,s=t["media-url"]||t.mediaUrl;return{"open-url":e,"media-url":s}}if(this.isSurge()){let e=t.url||t.openUrl||t["open-url"];return{url:e}}}};if(this.isMute||(this.isSurge()||this.isLoon()?$notification.post(e,s,i,o(r)):this.isQuanX()&&$notify(e,s,i,o(r))),!this.isMuteLog){let t=["","==============📣系统通知📣=============="];t.push(e),s&&t.push(s),i&&t.push(i),console.log(t.join("\n")),this.logs=this.logs.concat(t)}}log(...t){t.length>0&&(this.logs=[...this.logs,...t]),console.log(t.join(this.logSeparator))}logErr(t,e){const s=!this.isSurge()&&!this.isQuanX()&&!this.isLoon();s?this.log("",`❗️${this.name}, 错误!`,t.stack):this.log("",`❗️${this.name}, 错误!`,t)}wait(t){return new Promise(e=>setTimeout(e,t))}done(t={}){const e=(new Date).getTime(),s=(e-this.startTime)/1e3;this.log("",`🔔${this.name}, 结束! ⏱ ${s} 秒`),this.log(),(this.isSurge()||this.isQuanX()||this.isLoon())&&$done(t)}}(t,e)}
