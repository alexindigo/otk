// SPDX-License-Identifier: LGPL-3.0-only
/** Browser-side label text bounds, independent of transparent wrappers.
 * Native controls/options are excluded so a select's value is not its label. */
export const labelTextBounds = `(control) => {
  const label = control.closest('label');
  if (!label) throw new Error('Native control has no label');
  const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
  const range = document.createRange(), rects = [];
  for (let node; (node = walker.nextNode());) {
    if (!node.textContent.trim() || node.parentElement.closest('input,select,textarea,button')) continue;
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width || rect.height) rects.push(rect);
  }
  if (!rects.length) throw new Error('Native control label has no visible text');
  const left = Math.min(...rects.map(r => r.left)), top = Math.min(...rects.map(r => r.top));
  const right = Math.max(...rects.map(r => r.right)), bottom = Math.max(...rects.map(r => r.bottom));
  return {x:left,y:top,left,top,right,bottom,width:right-left,height:bottom-top};
}`;

/** SVG-to-control edge gaps, accounting for the actual native border. */
export const accessoryGeometry = `(()=>{
 const controls=[...document.querySelectorAll('.otk-select select,.otk-control-trigger')].filter(e=>e.getBoundingClientRect().width&&getComputedStyle(e).visibility!=='hidden');
 return controls.map(control=>{const owner=control.matches('select')?control.parentElement:control,icon=owner.querySelector('.otk-control-accessory svg'),r=control.getBoundingClientRect(),s=getComputedStyle(control),i=icon?.getBoundingClientRect();return {label:control.getAttribute('aria-label')??control.name,height:r.height,icon:i?[i.width,i.height]:null,gaps:i?[i.top-r.top-parseFloat(s.borderTopWidth),r.bottom-i.bottom-parseFloat(s.borderBottomWidth),r.right-i.right-parseFloat(s.borderRightWidth)]:[]};});
})()`;
