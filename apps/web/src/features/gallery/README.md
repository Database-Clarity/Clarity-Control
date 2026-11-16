# UI gallery

Management → UI gallery (`#/management/ui`, maintainers only; it shows no data) renders every
shared element in its states with fixture props: the real components, imported, never copied.

For agents building UI:

- **Use what is here.** Before writing a button, field, popover, dialog, skeleton, tab strip, or
  diff view, find it in `entries.tsx` and import it from the path the entry shows.
- **Add new shared pieces here first.** A new component under `apps/web/src/ui/**` needs an entry
  (`covers: ['Name']`); `coverage.test.tsx` fails until it has one, or until it is listed in
  `excluded` with a reason. Widely reused feature pieces get an entry too.
- Fixtures stay inline and real (Destiny text, real markup, long German, Polish, and Russian
  strings). A demo never saves anything: a component that calls the server takes a presentational
  part out (see `InactiveMoveConfirm`); remembered choices (Raw, Sheet colours) stay in the
  frame's in-memory copy of browser storage (`isolateStorage`).

How it works: `GalleryPage` (the toolbar) loads `GalleryFrame` in an iframe at
`#/management/ui/frame`, outside the app shell. The frame is a real document, so its width
(390/768/1280) drives the phone and tablet layouts, and the theme, UI scale, and touch size apply
to it alone (never saved). Reduced motion turns off the frame's animations and transitions; the
OS setting itself cannot be switched from a page. Both are lazy chunks, never preloaded.
