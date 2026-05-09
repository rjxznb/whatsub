import { Nav } from '@/components/Nav';
import { Hero } from '@/components/Hero';
import { WhyCards } from '@/components/WhyCards';
import { HowSteps } from '@/components/HowSteps';
import { FeatureGrid } from '@/components/FeatureGrid';
import { Footer } from '@/components/Footer';

export default function HomePage() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <WhyCards />
        <HowSteps />
        <FeatureGrid />
      </main>
      <Footer />
    </>
  );
}
