import { fileUrl } from "../../ui/api.ts";
import type { RendererProps, UiPlugin } from "../index.ts";

function ImageDoc(props: RendererProps): preact.JSX.Element {
  return (
    <div class="image">
      <img alt={props.doc.path} src={fileUrl(props.doc.path)} />
    </div>
  );
}

export const imageUi: UiPlugin = {
  id: "image",
  renderers: [{ accepts: (doc) => doc.mediaType.startsWith("image/"), component: ImageDoc }],
};
