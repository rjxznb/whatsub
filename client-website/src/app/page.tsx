import { Nav } from '@/components/Nav';
import { Hero } from '@/components/Hero';
import { WhyCards } from '@/components/WhyCards';
import { HowSteps } from '@/components/HowSteps';
import { FeatureGrid } from '@/components/FeatureGrid';
import { Download } from '@/components/Download';
import { Pricing } from '@/components/Pricing';
import { FAQ } from '@/components/FAQ';
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
        <Download />
        <Pricing />
        <FAQ />
      </main>
      <Footer />
    </>
  );
}
