// SPDX-License-Identifier: LGPL-3.0-only
/** Browser-side observation of the public selection item's flowing geometry. */
export function selectionGeometry(selector: string): string {
  return `(()=>{return [...document.querySelectorAll(${
    JSON.stringify(selector)
  })].filter(e=>e.getBoundingClientRect().width).map(e=>{
    const r=e.getBoundingClientRect(),s=getComputedStyle(e),m=e.querySelector('.otk-selection-marker'),p=m?.getBoundingClientRect(),vertical=e.dataset.otkSelection==='vertical',selected=e.classList.contains('is-selected');
    e.classList.toggle('is-selected');const other=e.getBoundingClientRect();e.classList.toggle('is-selected');
    return {orientation:e.dataset.otkSelection,selected,w:vertical?p?.width:r.width,h:vertical?p?.height:parseFloat(s.borderBottomWidth),centred:vertical?Math.abs(p.y+p.height/2-r.y-r.height/2):0,fill:s.backgroundColor,paint:vertical?getComputedStyle(m).backgroundColor:s.borderBottomColor,shift:Math.max(Math.abs(r.width-other.width),Math.abs(r.height-other.height)),position:vertical?getComputedStyle(m).position:s.position,ariaSelected:e.getAttribute('aria-selected'),ariaCurrent:e.getAttribute('aria-current'),ariaPressed:e.getAttribute('aria-pressed')};
  })})()`;
}
export interface SelectionGeometry {
  orientation: string;
  selected: boolean;
  w: number;
  h: number;
  centred: number;
  fill: string;
  paint: string;
  shift: number;
  position: string;
  ariaSelected: string | null;
  ariaCurrent: string | null;
  ariaPressed: string | null;
}
