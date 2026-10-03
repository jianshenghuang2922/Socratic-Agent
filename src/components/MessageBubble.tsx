import { RichText } from './RichText';
import { SourceList } from './SourceList';
import type { ChatMessage } from '@/lib/types';

const ROLE_LABEL: Record<ChatMessage['role'], string> = {
  user: '我',
  agent: 'Agent',
};

/** 普通文本气泡：用户与 Agent 采用不同样式 */
export function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.kind !== 'text') return null;
  const isUser = message.role === 'user';
  return (
    <div className={`row ${isUser ? 'row--user' : 'row--agent'}`}>
      <div className={`avatar ${isUser ? 'avatar--user' : 'avatar--agent'}`}>
        {isUser ? '我' : 'AI'}
      </div>
      <div className="bubble-group">
        <div className="bubble-meta">{ROLE_LABEL[message.role]}</div>
        <div className={`bubble ${isUser ? 'bubble--user' : 'bubble--agent'}`}>
          <RichText text={message.content} />
        </div>
        {/* RAG 溯源：让用户能判断这回答是有据可查还是模型在编 */}
        {!isUser && <SourceList sources={message.sources} />}
      </div>
    </div>
  );
}
