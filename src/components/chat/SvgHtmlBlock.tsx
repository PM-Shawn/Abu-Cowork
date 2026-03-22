import HtmlWidgetBlock from './HtmlWidgetBlock';
import { wrapSvgAsHtml } from './transforms';

export default function SvgHtmlBlock({ code }: { code: string }) {
  return <HtmlWidgetBlock code={wrapSvgAsHtml(code)} />;
}
