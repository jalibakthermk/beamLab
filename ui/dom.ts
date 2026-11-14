type Child = Node | string | null | undefined | false;

export interface ElProps {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (e: HTMLElementEventMap[K]) => void }>;
}

/** Small element builder. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  for (const [k, fn] of Object.entries(props.on ?? {})) node.addEventListener(k, fn as EventListener);
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}
