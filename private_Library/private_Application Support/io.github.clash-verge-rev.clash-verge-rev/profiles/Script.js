// Clash Verge 全局扩展脚本（对所有订阅生效，切换/更新订阅都不会丢）
//
// 背景：订阅规则里国内站点多靠 `GEOIP,CN,DIRECT` 兜底，而这条规则需要先解析 IP。
// 像豆包、抖音这类域名一次解析出十几个 IP 且顺序随机，GEOIP 判断会随机失败，
// 落到末尾的 `MATCH,<节点>` 走代理 —— 表现为"有时候打开很快、有时候转半天"。
// 这里用域名规则把它们钉死为直连，绕开 IP 判断的随机性。

function main(config, profileName) {
  const directRules = [
    // ── Edge 浏览器 ──
    //
    // 原则：基础可用性 > 速度。Edge 新标签页必须能打开，不能依赖代理节点存活。
    //
    // msn.com 直连较慢（公司网下 2~8s，家宽通常更快），但必须直连：
    // 若走代理，节点一挂 Edge 新标签页就完全打不开，这是可用性问题。
    // 建议同时关闭 Edge 新标签页的资讯流，这样几乎不会请求 msn.com。
    'DOMAIN-SUFFIX,msn.com,DIRECT',
    'DOMAIN-SUFFIX,msn.cn,DIRECT',
    'DOMAIN-SUFFIX,msftstatic.com,DIRECT',

    // bing.com 整体直连（DNS 修好后 DIRECT 解析正常，实测 0.22s）
    'DOMAIN-SUFFIX,bing.com,DIRECT',
    'DOMAIN,ecn.dev.virtualearth.net,DIRECT',
    'DOMAIN-SUFFIX,msftconnecttest.com,DIRECT',
    'DOMAIN-SUFFIX,msftncsi.com,DIRECT',

    // 微软 / Edge 自身服务：实测直连全部可用（0.3~1.0s），不依赖节点
    'DOMAIN,edge.microsoft.com,DIRECT',
    'DOMAIN,edgeupdates.microsoft.com,DIRECT',
    'DOMAIN,config.edge.skype.com,DIRECT',
    'DOMAIN-SUFFIX,microsoftonline.com,DIRECT',
    'DOMAIN,www.microsoft.com,DIRECT',
    'DOMAIN,www.office.com,DIRECT',
    'DOMAIN,login.live.com,DIRECT',

    // 仍保持走代理的（实测直连确实不可用）
    //   onedrive.live.com           直连不通
    //   edgeassets.microsoft.com    直连不通
    //   msedge.api.cdp.microsoft.com 直连不通

    // ── 豆包 ──
    'DOMAIN-SUFFIX,doubao.com,DIRECT',
    'DOMAIN-SUFFIX,byteimg.com,DIRECT',
    'DOMAIN-SUFFIX,bytescm.com,DIRECT',
    'DOMAIN-SUFFIX,ibytedapm.com,DIRECT',
    'DOMAIN-SUFFIX,byteacctimg.com,DIRECT',
    'DOMAIN-SUFFIX,bytedance.com,DIRECT',
    'DOMAIN-SUFFIX,zijieapi.com,DIRECT',
    'DOMAIN-SUFFIX,volccdn.com,DIRECT',
    'DOMAIN-SUFFIX,volcengine.com,DIRECT',

    // ── 抖音 ──
    'DOMAIN-SUFFIX,douyin.com,DIRECT',
    'DOMAIN-SUFFIX,iesdouyin.com,DIRECT',
    'DOMAIN-SUFFIX,douyinstatic.com,DIRECT',
    'DOMAIN-SUFFIX,douyinvod.com,DIRECT',
    'DOMAIN-SUFFIX,douyinpic.com,DIRECT',
    'DOMAIN-SUFFIX,douyincdn.com,DIRECT',
    'DOMAIN-SUFFIX,douyinmusic.com,DIRECT',
    'DOMAIN-SUFFIX,douyinact.com,DIRECT',
    'DOMAIN-SUFFIX,douyinguanjia.com,DIRECT',
    'DOMAIN-SUFFIX,douyinec.com,DIRECT',
    'DOMAIN-SUFFIX,douyinliving.com,DIRECT',

    // ── 字节跳动 CDN 群 ──
    'DOMAIN-SUFFIX,snssdk.com,DIRECT',
    'DOMAIN-SUFFIX,amemv.com,DIRECT',
    'DOMAIN-SUFFIX,bytecdn.cn,DIRECT',
    'DOMAIN-SUFFIX,bytefcdnrd.com,DIRECT',
    'DOMAIN-SUFFIX,zjcdn.com,DIRECT',
    'DOMAIN-SUFFIX,ixigua.com,DIRECT',
    'DOMAIN-SUFFIX,toutiao.com,DIRECT',

    // ── 全局国内兜底（放在数组末尾，优先级低于上面的具体域名）──
    // 目的：无论用哪个订阅（包括自建的极简 profile），国内站点都必须直连，
    // 不依赖订阅作者是否写了国内分流规则，也不受代理节点存活影响。
    //
    // 顺序即速度：纯后缀匹配 → 域名库 → IP 判断（需 DNS 解析，最慢）
    'DOMAIN-SUFFIX,cn,DIRECT',
    'GEOSITE,cn,DIRECT',
    'GEOIP,CN,DIRECT',
  ];

  const rules = config.rules || [];
  const existing = new Set(rules);
  const toAdd = directRules.filter((r) => !existing.has(r));

  // 插到规则最前面，保证优先于订阅自带的 MATCH 兜底
  config.rules = toAdd.concat(rules);

  // ── 强制注入 DNS ──
  // 原因：Verge 的 profile_dns_settings 会在重启时被重置为 false，
  // 导致 dns_config.yaml 不生效（内核 dns=None → root 进程系统解析不稳定）。
  // 源码顺序：apply_dns_settings 在前，global_script 在后，所以这里注入不会被覆盖。
  config.dns = {
    enable: true,
    ipv6: false,
    listen: ':53',
    'enhanced-mode': 'fake-ip',
    'fake-ip-range': '198.18.0.1/16',
    'fake-ip-filter-mode': 'blacklist',
    'prefer-h3': false,
    'respect-rules': false,
    'use-hosts': false,
    'use-system-hosts': false,
    'fake-ip-filter': [
      '*.lan',
      '*.local',
      '*.arpa',
      'time.*.com',
      'ntp.*.com',
      'localhost.ptlogin2.qq.com',
      '*.msftncsi.com',
      'www.msftconnecttest.com',
    ],
    'default-nameserver': ['223.5.5.5', '119.29.29.29'],
    nameserver: [
      'https://doh.pub/dns-query',
      'https://dns.alidns.com/dns-query',
      '223.5.5.5',
      '119.29.29.29',
    ],
    fallback: [],
    'fallback-filter': { geoip: true, 'geoip-code': 'CN' },
    'nameserver-policy': {},
    'proxy-server-nameserver': ['223.5.5.5', '119.29.29.29'],
    'direct-nameserver': [],
    'direct-nameserver-follow-policy': false,
  };

  return config;
}
