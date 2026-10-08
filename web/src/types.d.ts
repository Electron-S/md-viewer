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

/** 빌드 때 package.json의 version으로 바뀐다 */
declare const __MDV_VERSION__: string;
