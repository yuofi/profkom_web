import { Node } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import { Gallery } from './Gallery';

export const GalleryExtension = Node.create({
  name: 'gallery',
  group: 'block',
  atom: true,
  priority: 1000,

  addAttributes() {
    return {
      content: {
        default: '',
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'pre',
        getAttrs: (element) => {
          if (typeof element === 'string') return false;
          const code = (element as HTMLElement).querySelector('code');
          if (code && code.classList.contains('language-gallery')) {
            return { content: code.textContent };
          }
          return false;
        },
        priority: 1100,
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['pre', ['code', { class: 'language-gallery' }, HTMLAttributes.content]];
  },

  addStorage() {
    return {
      markdown: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serialize: (state: any, node: any) => {
          state.write('```gallery\n');
          state.text(node.attrs.content);
          state.ensureNewLine();
          state.write('```');
          state.closeBlock(node);
        },
      }
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(({ node, updateAttributes }) => {
      return (
        <NodeViewWrapper className="gallery-node-view">
          <Gallery 
            initialContent={node.attrs.content} 
            mode="edit" 
            onChange={(newContent) => updateAttributes({ content: newContent })}
          />
        </NodeViewWrapper>
      );
    });
  },
});
