/**
 * 下拉面板渲染到 `document.body` 之后留下的一个共同问题。
 *
 * 面板离开了触发它的那棵 DOM 子树（这正是它不被后面的卡片裁掉的原因），于是
 * 任何「按下的位置不在我的子树里就关掉自己」的浮层——账户菜单、气泡、弹出面
 * 板——都会把点选项的那次 mousedown 当成点在外面：浮层先关，选项按钮跟着卸
 * 载，click 再也到不了它的处理函数。用户看到的是下拉点不动。
 *
 * 所以每个这样的面板都带上 `data-portal-menu`，浮层判断「外面」时把落在它里
 * 面的目标排除掉。
 */

/** 面板根元素上的标记属性，值写明是哪一种面板，便于排查。 */
export const PORTAL_MENU_SELECTOR = '[data-portal-menu]';

/** 事件目标是否落在某个此类面板里。 */
export function isInsidePortalMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(PORTAL_MENU_SELECTOR) !== null;
}
