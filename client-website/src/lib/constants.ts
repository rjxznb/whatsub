/**
 * Brand tokens + external link constants. Importable from any component.
 * Brand source of truth: client/src/components/WelcomeIntro.tsx (the
 * desktop app's intro animation).
 */
export const BRAND = {
  bg: '#000000',
  bgSoft: '#0a0a0c',
  bgElev: '#141418',
  hairline: 'rgba(255,255,255,0.08)',
  hairlineStrong: 'rgba(255,255,255,0.14)',
  ink: '#ffffff',
  inkSoft: 'rgba(255,255,255,0.72)',
  inkMuted: 'rgba(255,255,255,0.48)',
  inkFaint: 'rgba(255,255,255,0.30)',
  accent: '#3B9BFF',
  accentGlow: 'rgba(59, 155, 255, 0.35)',
  amber: '#FCD34D',
} as const;

/**
 * External links. User can edit these values without rebuilding any
 * component logic — just update here, run pnpm build, redeploy.
 */
export const LINKS = {
  // 小红书 store URL — user fills in real product page URL.
  // Until then, points at the user's profile.
  xhsStore: 'https://www.xiaohongshu.com/user/profile/67f1f5dc000000000e0119bf',

  // Backup downloads when /download/{win,mac} is unreachable.
  githubReleases: 'https://github.com/rjxznb/whatsub-releases/releases/latest',
  jihulabReleases: 'https://jihulab.com/rjxznb-group/whatsub-release/-/releases',

  // Customer support — same xhs profile for now.
  supportXhs: 'https://www.xiaohongshu.com/user/profile/67f1f5dc000000000e0119bf',

  // ICP filing.
  icpRecord: '京ICP备2026014893号-1',
  icpUrl: 'https://beian.miit.gov.cn',
} as const;

/**
 * Pricing — single tier. User edits here for now (¥XX placeholder).
 * Eventually move to a CMS or env if the price gets dynamic.
 */
export const PRICING = {
  amount: '¥99',           // user fills in real price
  period: null as string | null,
  label: '永久授权',
  features: [
    '永久使用，不订阅',
    '一份授权码可在 3 台设备同时激活',
    '换设备联系客服免费释放槽位',
    '所有未来更新免费',
    '不限制视频数量、不限制使用时长',
  ],
} as const;
