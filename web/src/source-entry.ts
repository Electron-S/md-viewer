// 원문 보기(CodeMirror) 번들 진입점. 처음 쓸 때 <script src="source.js">로 불러온다 (NFR-PERF-01).
import { SourceView } from './views/source';

(window as any).__mdvSourceView = SourceView;
