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
