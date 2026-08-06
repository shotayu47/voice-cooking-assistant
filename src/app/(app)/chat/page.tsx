import { getOrCreateConversation, loadMessages } from '@/lib/ai/service';
import { getOpenSession } from '@/lib/cooking/service';
import { getServiceContext } from '@/lib/supabase/server';

import { ChatView } from './chat-view';

export const metadata = { title: 'AIに相談 | 料理アシスタント' };

export default async function ChatPage() {
  const { ctx } = await getServiceContext();

  const session = await getOpenSession(ctx);
  const conversationId = await getOrCreateConversation(ctx, session?.id ?? null);
  const stored = await loadMessages(ctx, conversationId);

  // Tool traffic is persisted for replay but is noise in the transcript.
  const visible = stored
    .filter((message) => message.role !== 'tool' && (message.content ?? '').trim() !== '')
    .map((message) => ({
      id: message.id,
      role: message.role as 'user' | 'assistant',
      content: message.content ?? '',
    }));

  return (
    <ChatView
      initialMessages={visible}
      cookingSessionId={session?.id ?? null}
      cookingTitle={session?.recipe_snapshot?.title ?? null}
    />
  );
}
