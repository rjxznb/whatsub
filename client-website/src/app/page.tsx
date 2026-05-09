import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';

export default function HomePage() {
  return (
    <>
      <Nav />
      <main className="min-h-screen pt-16">
        <div className="mx-auto max-w-[1200px] px-6 py-32 text-center">
          <p className="text-[--ink-muted]">page.tsx stub — sections land in PB2-PB5</p>
        </div>
      </main>
      <Footer />
    </>
  );
}
