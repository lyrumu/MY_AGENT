// Clash Verge 全局扩展脚本（对所有订阅生效，切换/更新订阅都不会丢）
//
// 背景：订阅规则里国内站点多靠 `GEOIP,CN,DIRECT` 兜底，而这条规则需要先解析 IP。
// 像豆包、抖音这类域名一次解析出十几个 IP 且顺序随机，GEOIP 判断会随机失败，
// 落到末尾的 `MATCH,<节点>` 走代理 —— 表现为"有时候打开很快、有时候转半天"。
// 这里用域名规则把它们钉死为直连，绕开 IP 判断的随机性。

function main(config, profileName) {
  const directRules = [
    // ── Edge 浏览器：只保留“国内直连确实快”的少数域名 ──
    // 实测方法：同一域名分别直连 / 走节点测延迟，取更快的一边。
    //
    // 注意 bing.com：早期 mihomo 的 DNS 段被禁用（dns=None）时，直连会 TLS 握手失败；
    // 现在 DNS 已在脚本末尾注入并生效，直连恢复正常（实测 0.22s，优于走代理 1~5s）。
    'DOMAIN-SUFFIX,bing.com,DIRECT',
    'DOMAIN,ecn.dev.virtualearth.net,DIRECT',
    'DOMAIN-SUFFIX,msftconnecttest.com,DIRECT',
    'DOMAIN-SUFFIX,msftncsi.com,DIRECT',

    // ── 以下绝对不能直连（国内直连极慢），保持走代理 ──
    //   msn.com / msn.cn          直连 4.3s       代理 0.22s
    //   assets.msn.com            直连 2.9s       代理 0.11s
    //   datadoghq.com             直连 3.7s       代理 0.31s
    //   scorecardresearch.com     直连 0.34s      代理 0.26s
    //   edge.microsoft.com        直连 0.22s      代理 0.11s
    //   config.edge.skype.com     直连 0.34s      代理 0.10s
    //   edgeupdates.microsoft.com 直连 5.3s       代理 0.10s
    //   microsoftonline.com       直连 超时      代理 0.71s
    //   www.microsoft.com         直连 3.5s       代理 0.13s

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
