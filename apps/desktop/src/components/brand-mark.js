import { jsx as _jsx } from "react/jsx-runtime";
import { cn } from '@/lib/utils';
const assetPath = (path) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`;
// Brand badge: the Nemesis winged mark on a black tile, identical in light/dark.
// Fills the tile (softly rounded); size via className (default size-14).
export function BrandMark({ className, ...props }) {
    return (_jsx("span", { className: cn('inline-flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-black', className), ...props, children: _jsx("img", { alt: "", className: "size-full object-contain", src: assetPath('nemesis-mark.png') }) }));
}
