export default function ShoutboxHeader({ name }: { name: string }) {
  return (
    <div className="channel-header shoutbox-header">
      <span className="channel-hash">#</span>
      <span className="channel-name">{name}</span>
    </div>
  );
}
