import { useState } from "preact/hooks";

import type { PageHalf, RendererProps } from "../../runtime/extension.ts";
import { docUrl } from "../../runtime/page/api.ts";
import type { ImagePlugs } from "./contract.ts";

/** Fitted to the pane, or at its real size on a click, back on the next; one that fits already takes no click. */
function ImageDoc(props: RendererProps): preact.JSX.Element {
  const [real, setReal] = useState(false);
  const [zoomable, setZoomable] = useState(false);

  return (
    <div class={zoomable ? (real ? "image real" : "image fit") : "image"}>
      <img
        alt={props.doc.path}
        src={docUrl(props.doc)}
        onLoad={(event) => {
          const image = event.currentTarget;
          setZoomable(image.naturalWidth > image.clientWidth);
        }}
        onClick={() => setReal(zoomable && !real)}
      />
    </div>
  );
}

export const page: PageHalf<ImagePlugs> = {
  id: "image",
  renderers: [{ accepts: (doc) => doc.mediaType.startsWith("image/"), component: ImageDoc }],
};
