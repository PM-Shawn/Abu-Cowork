import type { ChatReference } from '@/types/chatReference';

export interface SelectionSourceContext {
  path: string;
  name: string;
}

/** 把一次 DOM Selection 抽取成引用；无有效选区返回 null。不同文档类型各实现一个。 */
export interface SelectionSource {
  docType: ChatReference['source']['docType'];
  extract(sel: Selection, ctx: SelectionSourceContext): ChatReference | null;
}
