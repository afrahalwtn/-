// Official Tabler SVG icons adapted from https://github.com/tabler/tabler-icons (MIT license).
const tablerPaths = {
  "table": "<path d=\"M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14\" /> <path d=\"M3 10h18\" /> <path d=\"M10 3v18\" />",
  "receipt": "<path d=\"M5 21v-16a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v16l-3 -2l-2 2l-2 -2l-2 2l-2 -2l-3 2m4 -14h6m-6 4h6m-2 4h2\" />",
  "minus": "<path d=\"M5 12l14 0\" />",
  "tag": "<path d=\"M6.5 7.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0\" /> <path d=\"M3 6v5.172a2 2 0 0 0 .586 1.414l7.71 7.71a2.41 2.41 0 0 0 3.408 0l5.592 -5.592a2.41 2.41 0 0 0 0 -3.408l-7.71 -7.71a2 2 0 0 0 -1.414 -.586h-5.172a3 3 0 0 0 -3 3\" />",
  "menu": "<path d=\"M4 6l16 0\" /> <path d=\"M4 12l16 0\" /> <path d=\"M4 18l16 0\" />",
  "search": "<path d=\"M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0\" /> <path d=\"M21 21l-6 -6\" />",
  "logout": "<path d=\"M14 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2\" /> <path d=\"M9 12h12l-3 -3\" /> <path d=\"M18 15l3 -3\" />",
  "alert": "<path d=\"M12 9v4\" /> <path d=\"M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0\" /> <path d=\"M12 16h.01\" />",
  "edit": "<path d=\"M7 7h-1a2 2 0 0 0 -2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2 -2v-1\" /> <path d=\"M20.385 6.585a2.1 2.1 0 0 0 -2.97 -2.97l-8.415 8.385v3h3l8.385 -8.415\" /> <path d=\"M16 5l3 3\" />",
  "printer": "<path d=\"M17 17h2a2 2 0 0 0 2 -2v-4a2 2 0 0 0 -2 -2h-14a2 2 0 0 0 -2 2v4a2 2 0 0 0 2 2h2\" /> <path d=\"M17 9v-4a2 2 0 0 0 -2 -2h-6a2 2 0 0 0 -2 2v4\" /> <path d=\"M7 15a2 2 0 0 1 2 -2h6a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-6a2 2 0 0 1 -2 -2l0 -4\" />",
  "arrow": "<path d=\"M15 6l-6 6l6 6\" />",

  "home": "<path d=\"M5 12l-2 0l9 -9l9 9l-2 0\" /> <path d=\"M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7\" /> <path d=\"M10 12h4v4h-4l0 -4\" />",
  "package": "<path d=\"M12 3l8 4.5l0 9l-8 4.5l-8 -4.5l0 -9l8 -4.5\" /> <path d=\"M12 12l8 -4.5\" /> <path d=\"M12 12l0 9\" /> <path d=\"M12 12l-8 -4.5\" /> <path d=\"M16 5.25l-8 4.5\" />",
  "clipboard": "<path d=\"M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2\" /> <path d=\"M9 5a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2\" /> <path d=\"M9 14l2 2l4 -4\" />",
  "bell": "<path d=\"M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6\" /> <path d=\"M9 17v1a3 3 0 0 0 6 0v-1\" />",
  "file": "<path d=\"M14 3v4a1 1 0 0 0 1 1h4\" /> <path d=\"M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2\" /> <path d=\"M9 7l1 0\" /> <path d=\"M9 13l6 0\" /> <path d=\"M13 17l2 0\" />",
  "users": "<path d=\"M10 13a2 2 0 1 0 4 0a2 2 0 0 0 -4 0\" /> <path d=\"M8 21v-1a2 2 0 0 1 2 -2h4a2 2 0 0 1 2 2v1\" /> <path d=\"M15 5a2 2 0 1 0 4 0a2 2 0 0 0 -4 0\" /> <path d=\"M17 10h2a2 2 0 0 1 2 2v1\" /> <path d=\"M5 5a2 2 0 1 0 4 0a2 2 0 0 0 -4 0\" /> <path d=\"M3 13v-1a2 2 0 0 1 2 -2h2\" />",
  "shield": "<path d=\"M11.46 20.846a12 12 0 0 1 -7.96 -14.846a12 12 0 0 0 8.5 -3a12 12 0 0 0 8.5 3a12 12 0 0 1 -.09 7.06\" /> <path d=\"M15 19l2 2l4 -4\" />"
};
// Selected inline SVG path shapes in the visual language of Lucide Icons (ISC).
// https://github.com/lucide-icons/lucide  — see THIRD_PARTY_LICENSES.md
const paths = {
  'user-check': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m17 11 2 2 4-4"/>',
  
  home:'<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M9 21v-7h6v7"/>',
  package:'<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/>',
  clipboard:'<rect x="6" y="5" width="14" height="16" rx="2"/><rect x="9" y="3" width="8" height="4" rx="1"/><path d="m10 14 2 2 4-4"/>',
  bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
  file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/>',
  users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  menu:'<path d="M4 7h16M4 12h16M4 17h16"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  check:'<path d="m4 12 5 5L20 6"/>',
  edit:'<path d="m15 5 4 4M4 20l4.5-1 11-11a2.83 2.83 0 0 0-4-4l-11 11L4 20Z"/>',
  trash:'<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
  alert:'<path d="m10.3 3-9 16a2 2 0 0 0 1.7 3h18a2 2 0 0 0 1.7-3l-9-16a2 2 0 0 0-3.4 0Z"/><path d="M12 9v5M12 18h.01"/>',
  shield:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  logout:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  eye:'<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff:'<path d="M3 3 21 21M10.6 5.1A11 11 0 0 1 12 5c6.5 0 10 7 10 7a15.1 15.1 0 0 1-3.1 4.1M6.8 6.8C3.6 8.8 2 12 2 12s3.5 7 10 7a11 11 0 0 0 4.1-.8"/>',
  arrow:'<path d="M19 12H5M12 19l-7-7 7-7"/>',
  chevron:'<path d="m15 18-6-6 6-6"/>',
  printer:'<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 15h12v7H6zM17 12h.01"/>',
  image:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  save:'<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  x:'<path d="M18 6 6 18M6 6l12 12"/>',
  box:'<path d="M4 7 12 3l8 4v10l-8 4-8-4zM4 7l8 5 8-5M12 12v9"/>',
  lock:'<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 9a7 7 0 0 1 12-2l2 5M4 12l2 5a7 7 0 0 0 12-2"/>',
  sort:'<path d="m7 10 5-5 5 5M17 14l-5 5-5-5"/>',
};
export function icon(name, size=20) {
  const p = tablerPaths[name] || paths[name] || tablerPaths.package;
  return `<svg xmlns="http://www.w3.org/2000/svg" class="i i-tabler" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
