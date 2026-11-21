const SELECTED = '[aria-pressed="true"], [aria-checked="true"], [aria-selected="true"]';

/** The selected option's background slides between options instead of jumping. Pass as the
 *  group's `ref`; options mark the selection with aria-pressed, aria-checked or aria-selected. */
export const segmentThumb = (group: HTMLElement | null) => (group ? attachThumb(group) : undefined);

export function attachThumb(group: HTMLElement) {
  const place = () => {
    const selected = [...group.children].find(
      (child): child is HTMLElement => child instanceof HTMLElement && child.matches(SELECTED),
    );
    if (!selected) {
      group.style.removeProperty('--sf-thumb-w');
      return;
    }
    group.style.setProperty('--sf-thumb-x', `${selected.offsetLeft}px`);
    group.style.setProperty('--sf-thumb-y', `${selected.offsetTop}px`);
    group.style.setProperty('--sf-thumb-w', `${selected.offsetWidth}px`);
    group.style.setProperty('--sf-thumb-h', `${selected.offsetHeight}px`);
  };
  // The first position is placed without a slide; later changes animate.
  group.dataset.thumb = 'still';
  place();
  const frame = requestAnimationFrame(() => (group.dataset.thumb = 'slide'));
  const mutations = new MutationObserver(place);
  mutations.observe(group, {
    subtree: true,
    childList: true,
    attributeFilter: ['aria-pressed', 'aria-checked', 'aria-selected'],
  });
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
  resize?.observe(group);
  return () => {
    cancelAnimationFrame(frame);
    mutations.disconnect();
    resize?.disconnect();
    delete group.dataset.thumb;
  };
}
