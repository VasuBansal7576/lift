export interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowChrome {
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
  innerWidth: number;
  innerHeight: number;
}

/** Map a Playwright viewport box to X11 screen coordinates for xdotool mousemove. */
export function viewportToScreen(box: ViewBox, win: WindowChrome): { x: number; y: number } {
  const chromeLeft = (win.outerWidth - win.innerWidth) / 2;
  const chromeTop = win.outerHeight - win.innerHeight - chromeLeft;
  return {
    x: Math.round(win.screenX + chromeLeft + box.x + box.width / 2),
    y: Math.round(win.screenY + chromeTop + box.y + box.height / 2),
  };
}

export const RECORDING_TRAFFIC_N_T2 = 1000;
export const RECORDING_TRAFFIC_N_L2 = 400;
export const RECORDING_EXTRA_ROUNDS = 0;
