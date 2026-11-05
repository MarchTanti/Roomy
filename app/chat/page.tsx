import type { Metadata } from 'next';

import { ChatClient } from './chat-client';

export const metadata: Metadata = {
  title: 'RoomyAI — แชทแนะนำเฟอร์นิเจอร์',
};

export default function ChatPage() {
  return <ChatClient />;
}