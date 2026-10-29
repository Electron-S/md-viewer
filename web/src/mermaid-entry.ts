// Mermaid 번들 진입점 (FR-REN-07). 빌드가 gzip해 viewer.html에 데이터로 넣고, 처음 다이어그램을 그릴 때 무대 iframe 안에서
// 풀어 실행한다 (render/diagrams.ts, SDD 7.5). 여기의 window는 그 iframe의 window다.
import mermaid from 'mermaid';

(window as any).__mdvMermaid = mermaid;
