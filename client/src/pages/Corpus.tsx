import { useState } from 'react';
import { CorpusSceneTree } from '../components/CorpusSceneTree';
import { CorpusPhraseList } from '../components/CorpusPhraseList';
import { CorpusPhraseDetail } from '../components/CorpusPhraseDetail';

export function Corpus() {
  const [scene, setScene] = useState<string | null>('social');
  const [phrase, setPhrase] = useState<string | null>(null);

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      <CorpusSceneTree
        selected={scene}
        onSelect={(s) => { setScene(s); setPhrase(null); }}
      />
      <CorpusPhraseList
        scene={scene}
        selected={phrase}
        onSelect={setPhrase}
      />
      <CorpusPhraseDetail phraseNormalized={phrase} />
    </div>
  );
}
