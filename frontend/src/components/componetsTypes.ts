import type { SVGProps } from "react";

export type MainElementVariant = "desktop" | "mobile";

export interface MainElementProps extends SVGProps<SVGSVGElement> {
    variant: MainElementVariant,
    className?: string
}
// export interface IconProps extends SVGProps<SVGSVGElement> {
//     variant: "mobile" | "desktop"
// }