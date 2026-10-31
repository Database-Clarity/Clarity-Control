import { parse, type DefaultTreeAdapterTypes } from 'parse5';

export type HtmlNode = DefaultTreeAdapterTypes.Node;
export type HtmlElement = DefaultTreeAdapterTypes.Element;
export function elements(node: HtmlNode): HtmlElement[] {
  return 'childNodes' in node
    ? node.childNodes.filter((child): child is HtmlElement => 'tagName' in child)
    : [];
}
export function descendants(node: HtmlNode, tag: string): HtmlElement[] {
  return elements(node).flatMap((child) => [
    ...(child.tagName === tag ? [child] : []),
    ...descendants(child, tag),
  ]);
}
export function attr(node: HtmlElement, name: string): string {
  return node.attrs.find((attribute) => attribute.name === name)?.value ?? '';
}
export function textContent(node: HtmlNode): string {
  if ('value' in node) return node.value;
  return 'childNodes' in node ? node.childNodes.map(textContent).join('') : '';
}
export { parse };
