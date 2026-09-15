import { fileUrl } from "../../ui/state.ts";
import type { RendererProps, UiPlugin } from "../index.ts";

function HtmlDoc(props: RendererProps): preact.JSX.Element {
  return <iframe title={props.doc.path} sandbox="allow-scripts" src={fileUrl(props.doc.path)} />;
}

export const htmlUi: UiPlugin = {
  id: "html",
  renderers: [{ accepts: (doc) => doc.mediaType === "text/html", component: HtmlDoc }],
};
