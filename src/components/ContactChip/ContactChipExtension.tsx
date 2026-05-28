import { Node } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import { ContactChip } from './ContactChip';

export const ContactChipExtension = Node.create({
  name: 'contactChip',
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
          if (code && code.classList.contains('language-chip')) {
            return { content: code.textContent };
          }
          return false;
        },
        priority: 1100,
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['pre', ['code', { class: 'language-chip' }, HTMLAttributes.content]];
  },

  addStorage() {
    return {
      markdown: {
        serialize: (state: any, node: any) => {
          state.write('```chip\n');
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
        <NodeViewWrapper className="contact-chip-node-view">
          <ContactChip 
            initialContent={node.attrs.content} 
            mode="edit" 
            onChange={(newContent) => updateAttributes({ content: newContent })}
          />
        </NodeViewWrapper>
      );
    });
  },
});
