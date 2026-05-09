import { Nav } from '@/components/Nav';
import { Hero } from '@/components/Hero';
import { Footer } from '@/components/Footer';

export default function HomePage() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
      </main>
      <Footer />
    </>
  );
}
