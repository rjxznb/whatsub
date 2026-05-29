import type { UserMessage } from "../../types/agent";

interface Props {
  msg: UserMessage;
}

export function UserBubble({ msg }: Props) {
  return (
    <div className="flex justify-end my-2 px-2">
      <div className="max-w-[80%] bg-blue-500/15 border border-blue-500/30 text-zinc-200 text-sm rounded-lg px-3 py-2 whitespace-pre-wrap break-words">
        {msg.content}
      </div>
    </div>
  );
}
