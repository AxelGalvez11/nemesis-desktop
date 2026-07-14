import { cn } from '../lib/utils'
import nemesisMark from '../../../desktop/public/nemesis-mark.png'

// Reuse the same chrome Nemesis mark as the desktop shell; Vite fingerprints
// and bundles this source asset into the installer build.
export function BrandMark({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'inline-flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-black',
        className
      )}
      {...props}
    >
      <img alt="" className="size-full object-contain" src={nemesisMark} />
    </span>
  )
}
