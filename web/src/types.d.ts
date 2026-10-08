declare module 'markdown-it-footnote' {
  const plugin: (md: any) => void;
  export default plugin;
}

declare module 'markdown-it-task-lists' {
  const plugin: (md: any, opts?: { enabled?: boolean; label?: boolean; labelAfter?: boolean }) => void;
  export default plugin;
}

declare module '*.css' {
  const text: string;
  export default text;
}
