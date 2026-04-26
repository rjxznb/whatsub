#!/usr/bin/env python3
"""Scan ALL 439 YouTube Commons parquet files for EngHub scene candidates."""
import pandas as pd
import re
import sys
import os
import time

PARQUET_DIR = 'F:/youtube_cc'
OUTPUT_FILE = 'C:/Users/renjx/Desktop/Get_Video/data/youtube_commons_candidates.md'

scene_title_patterns = {
    'immigration': r'\b(visa interview|passport control|immigration (check|officer|process|interview)|border (control|crossing|patrol)|customs (check|declaration|officer)|baggage claim|arrivals? hall|port of entry|TSA|CBP officer|global entry|visa (application|process|tips|guide|questions|answers)|green card interview|naturalization|asylum interview|consulate|embassy interview)\b',
    'housing': r'\b(apartment (tour|hunt|viewing|search|shopping)|flat (tour|viewing|share|hunting)|room tour|renting|landlord|lease (agreement|signing)|move.?in (day|vlog)|house (tour|hunting)|dorm (tour|room)|roommate|tenant|studio apartment|property (viewing|tour)|how to rent)\b',
    'medical': r'\b(doctor.s? (visit|appointment|office)|GP (appointment|visit|surgery)|pharma(cy|cist)|symptom|diagnos|medical (check|exam|visit)|hospital (visit|stay|experience)|dentist (visit|appointment)|NHS|health (check|clinic)|urgent care|ER visit|emergency room|walk.in clinic|blood test|check.?up|seeing (a|the) doctor|prescription|sick|illness)\b',
    'campus': r'\b(college (day|life|vlog|tour|move.in|freshman|orientation)|university (tour|vlog|life|orientation)|campus (tour|life|vlog)|dorm (tour|room|move.in)|first day (of|at) (college|uni|school)|student life|study abroad|freshman (year|orientation|experience)|sorority|fraternity|college class|lecture hall|office hours|college advice|university advice)\b',
    'banking': r'\b(open.{0,10}(bank|account)|bank account|credit (card|score|report)|budgeting|financial (advice|literacy|planning)|savings? account|mortgage|how to (save|budget|invest)|debit card|checking account|wire transfer|money transfer|overdraft|credit union|banking (tips|advice)|interest rate|loan (application|approval))\b',
    'shopping': r'\b(grocery (haul|shopping|list|store)|supermarket|shopping (haul|vlog|tips|spree)|self.?checkout|thrift (haul|shopping|store|flip)|target (haul|run)|walmart (haul|shopping)|costco (haul|shopping)|dollar (tree|store)|haul video|what i bought|come shopping)\b',
    'transport': r'\b(subway|metro (transit|guide|system|rail)|public transport(ation)?|how to (take|ride|use).{0,15}(bus|train|subway|metro)|uber|lyft|getting around|transit (guide|system|tips)|airport.{0,10}(how|guide|tips|to city)|tube.{0,5}guide|oyster card|metro card|bus (ride|tour|guide|system)|train (ride|journey|travel|guide)|commut(e|ing)|taxi|rideshare)\b',
    'social': r'\b(small talk|conversation (tips|starter|skills|practice)|meeting (people|new|strangers)|socializ(e|ing)|making friends|introvert|networking (tips|event|skills)|ice.?break(er|ing)|how to talk to|social (skills|anxiety|interaction)|chit.?chat|party (tips|conversation))\b',
    'dining': r'\b(restaurant (review|vlog|experience|tour)|ordering (food|at|in)|food (order|truck|court)|cafe|coffee shop|how to order|tipping (guide|culture|in)|menu|waiter|server|eating out|brunch|food review|mukbang|what i (ate|ordered)|try(ing)?.{0,5}food)\b',
    'emergency': r'\b(911 call|999 call|emergency (call|room|situation|service|kit)|first aid|CPR|ambulance|accident (story|experience)|lost passport|stolen|fire (drill|safety|emergency)|what to do.{0,10}(emergency|accident)|roadside emergency|medical emergency|emergency (number|contact|plan))\b',
    'job': r'\b(job interview|interview (tips|question|prep|advice|practice|mistakes)|resume (tips|writing|review|template)|CV (tips|writing|review|template)|cover letter|career (advice|tips|change)|intern(ship)?|how to get (hired|a job)|job (search|hunting|application|offer)|work (experience|permit)|linkedin|salary (negotiation|talk)|workplace|getting (hired|fired)|first (job|day at work)|mock interview)\b',
    'phone': r'\b(phone call|customer service (call|tips|experience)|how to call|phone (etiquette|tips|conversation)|complaint (call|letter)|booking (call|by phone)|reservation|cancel.{0,10}(subscription|membership|order)|calling.{0,10}(bank|doctor|company|service)|hold music|automated phone|IVR|voicemail)\b',
    'salon': r'\b(hair(cut|style|salon|dresser)|barber(shop)?|nail (art|salon|design|tutorial)|spa (day|visit|experience|treatment)|trim|color.{0,5}hair|highlights|perm|blowout|hair (transformation|makeover|tutorial)|getting.{0,5}hair (cut|done|colored)|manicure|pedicure|beauty salon|lash|brow|waxing)\b',
    'driving': r'\b(driving (test|lesson|exam|school|tips|instructor)|driver.?s? (license|licence|permit|test|exam)|DMV|road test|learn(ing)? to drive|parallel park|behind the wheel|driving (practice|experience|vlog)|learner.?s? permit|pass(ing|ed)?.{0,5}driving test|fail(ed|ing)?.{0,5}driving test|theory test)\b',
    'travel': r'\b(hotel (review|tour|check.?in|room|stay|experience)|travel (tips|vlog|guide|hack|diary|journal)|sightseeing|tourist|vacation (vlog|guide)|trip (vlog|guide|plan)|hostel (tour|review|experience|stay)|car rental|airbnb (tour|review|stay)|travel (packing|essentials|budget)|backpack(ing|er)|road trip|flight (review|experience|tips)|layover|transit|airport (lounge|experience))\b',
    'fitness': r'\b(gym (tour|membership|vlog|routine|motivation)|workout|exercise|yoga|running|muscle|weight.{0,5}(loss|training|lifting)|fitness|HIIT|crossfit|home workout|full body|leg day|arm day|push day|pull day|abs|stretching|warm.?up|cool.?down|personal trainer|gym (beginner|newbie|first time))\b',
    'mental_health': r'\b(therap(y|ist)|counseli?ng|mental health|anxiety|depression|stress (management|relief|tips)|mindfulness|meditation|self.?care|wellbeing|well.?being|panic (attack|disorder)|OCD|PTSD|ADHD|burnout|emotional (health|support)|coping|journaling|gratitude|healing|trauma|toxic|boundaries|self.?esteem|self.?love|mental (illness|wellness|breakdown))\b',
    'maintenance': r'\b(plumb(er|ing)|electrician|repair|fix(ing|ed)?.{0,5}(leak|faucet|toilet|drain|pipe|wall|door|window|appliance|AC|heater)|home (repair|maintenance|improvement|renovation)|renovation|DIY (fix|repair|project|home)|moving (house|day|tips|vlog|apartment)|handyman|HVAC|how to (fix|repair|install|replace)|broken|clogged|leaky)\b',
}

text_patterns = {
    'immigration': r'\b(passport|visa|immigration|customs|border|declare|officer|consul|embassy|entry|arrival)\b',
    'housing': r'\b(rent|deposit|landlord|tenant|lease|apartment|flat|bedroom|bathroom|kitchen|living room|move|roommate)\b',
    'medical': r'\b(doctor|patient|symptom|prescri|medication|appointment|treatment|diagnos|nurse|clinic|hospital|pharmacy|health|sick)\b',
    'campus': r'\b(class|lecture|professor|campus|dorm|student|assignment|semester|enroll|college|university|library|exam|grade)\b',
    'banking': r'\b(bank|account|credit|savings|transfer|interest|deposit|withdraw|loan|mortgage|budget|money|financial)\b',
    'shopping': r'\b(buy|store|shopping|checkout|price|cart|aisle|receipt|coupon|sale|brand|product|item|purchase)\b',
    'transport': r'\b(subway|metro|bus|train|ticket|station|transit|ride|platform|fare|route|stop|transfer|line)\b',
    'social': r'\b(talk|conversation|people|friend|meet|chat|social|introduce|awkward|confident|nervous)\b',
    'dining': r'\b(order|menu|restaurant|food|waiter|server|table|tip|meal|eat|dish|cook|taste|delicious)\b',
    'emergency': r'\b(emergency|ambulance|hospital|police|accident|help|injury|fire|rescue|911|999|paramedic)\b',
    'job': r'\b(interview|resume|hire|job|career|salary|employer|experience|position|company|apply|offer|skill)\b',
    'phone': r'\b(call|phone|hold|speak|customer|service|complaint|booking|cancel|representative|automated)\b',
    'salon': r'\b(hair|cut|style|salon|barber|trim|color|wash|curl|straight|blow|dry|shampoo|condition)\b',
    'driving': r'\b(drive|road|car|license|permit|test|lane|speed|turn|mirror|brake|gear|clutch|steer|park)\b',
    'travel': r'\b(hotel|room|check.in|travel|trip|tour|visit|book|reservation|flight|luggage|pack|explore)\b',
    'fitness': r'\b(workout|exercise|gym|train|muscle|weight|rep|set|cardio|stretch|squat|push|pull|core)\b',
    'mental_health': r'\b(anxiety|depression|therapy|mental|stress|feel|emotion|thought|mindful|heal|cope|self|panic)\b',
    'maintenance': r'\b(fix|repair|tool|pipe|wire|wall|install|replace|broken|leak|plumb|drain|screw|drill)\b',
}

scene_chinese = {
    'immigration': '入境通关', 'housing': '住房安家', 'medical': '医疗健康',
    'campus': '校园学习', 'banking': '银行财务', 'shopping': '日常购物',
    'transport': '交通出行', 'social': '社交日常', 'dining': '餐饮',
    'emergency': '紧急情况', 'job': '求职职场', 'phone': '电话沟通',
    'salon': '美容美发', 'driving': '驾照开车', 'travel': '旅游度假',
    'fitness': '运动健身', 'mental_health': '心理健康', 'maintenance': '搬家维修',
}


def dialogue_score(text):
    text_sample = text[:1500]
    score = 0
    pronouns = len(re.findall(r'\b(I|you|we|my|your|me|us)\b', text_sample, re.I))
    if pronouns > 15: score += 2
    elif pronouns > 5: score += 1
    if text_sample.count('?') > 3: score += 1
    markers = len(re.findall(r'\b(so|okay|alright|yeah|sure|well|actually|basically|right|like)\b', text_sample, re.I))
    if markers > 8: score += 1
    if re.search(r'\b(hi|hello|hey|thanks|thank you|please|sorry|welcome)\b', text_sample, re.I):
        score += 1
    return min(score, 5)


def main():
    start = time.time()

    # Count total files
    all_files = sorted([f for f in os.listdir(PARQUET_DIR) if f.endswith('.parquet')])
    total_files = len(all_files)
    print(f"Found {total_files} parquet files", flush=True)

    # Load all files in batches
    all_candidates = {scene: [] for scene in scene_title_patterns}
    total_rows = 0
    total_en = 0

    batch_size = 20
    for batch_start in range(0, total_files, batch_size):
        batch_end = min(batch_start + batch_size, total_files)
        batch_files = all_files[batch_start:batch_end]

        dfs = []
        for fname in batch_files:
            fpath = os.path.join(PARQUET_DIR, fname)
            df = pd.read_parquet(fpath)
            dfs.append(df)

        batch_df = pd.concat(dfs, ignore_index=True)
        total_rows += len(batch_df)

        # Filter: English original + English transcript + suitable length
        en = batch_df[
            (batch_df['original_language'] == 'en') &
            (batch_df['transcription_language'] == 'en') &
            (batch_df['word_count'] >= 150) &
            (batch_df['word_count'] <= 2500)
        ].copy()
        total_en += len(en)

        # Match each scene
        for scene, title_pat in scene_title_patterns.items():
            txt_pat = text_patterns[scene]
            matches = en[en['title'].str.contains(title_pat, case=False, na=False, regex=True)]

            for _, row in matches.iterrows():
                text = str(row['text'])
                text_hits = len(re.findall(txt_pat, text[:1000], re.I))
                dlg = dialogue_score(text)
                total = min(text_hits, 4) + dlg + 1
                total = min(total, 10)

                if total >= 4:
                    all_candidates[scene].append({
                        'score': total,
                        'dialogue': dlg,
                        'video_id': row['video_id'],
                        'link': row['video_link'],
                        'title': str(row['title']).strip(),
                        'word_count': row['word_count'],
                        'channel': str(row['channel']).strip(),
                    })

        elapsed = time.time() - start
        print(f"  Batch {batch_start//batch_size + 1}/{(total_files + batch_size - 1)//batch_size}: "
              f"files {batch_start+1}-{batch_end}, "
              f"{total_rows:,} rows, {total_en:,} English, "
              f"{sum(len(v) for v in all_candidates.values())} candidates, "
              f"{elapsed:.0f}s", flush=True)

    # Deduplicate by video_id within each scene (same video may appear in multiple parquet files)
    for scene in all_candidates:
        seen = set()
        deduped = []
        for c in all_candidates[scene]:
            if c['video_id'] not in seen:
                seen.add(c['video_id'])
                deduped.append(c)
        all_candidates[scene] = sorted(deduped, key=lambda x: x['score'], reverse=True)

    elapsed = time.time() - start
    print(f"\nDone in {elapsed:.0f}s. Total rows: {total_rows:,}, English: {total_en:,}", flush=True)

    # Write markdown report
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        f.write("# YouTube Commons CC Video Candidates for EngHub\n\n")
        f.write(f"Scanned **{total_files}** parquet files from YouTube Commons dataset.\n\n")
        f.write(f"- Total rows: {total_rows:,}\n")
        f.write(f"- English videos (150-2500 words): {total_en:,}\n")
        f.write(f"- Total candidates (score >= 4): {sum(len(v) for v in all_candidates.values())}\n\n")

        f.write("## Summary\n\n")
        f.write(f"| Scene | Chinese | Candidates | Good (>=6) | Best |\n")
        f.write(f"|-------|---------|------------|------------|------|\n")
        total_c = 0
        total_g = 0
        for scene in sorted(all_candidates.keys()):
            vids = all_candidates[scene]
            good = [v for v in vids if v['score'] >= 6]
            best = vids[0]['score'] if vids else 0
            total_c += len(vids)
            total_g += len(good)
            f.write(f"| {scene} | {scene_chinese[scene]} | {len(vids)} | {len(good)} | {best} |\n")
        f.write(f"| **TOTAL** | | **{total_c}** | **{total_g}** | |\n\n")

        # Per-scene video lists
        for scene in sorted(all_candidates.keys()):
            vids = all_candidates[scene]
            if not vids:
                continue
            f.write(f"## {scene} ({scene_chinese[scene]}) — {len(vids)} candidates\n\n")
            f.write(f"| Score | Link | Title | Words | Channel |\n")
            f.write(f"|-------|------|-------|-------|---------|\n")
            for v in vids:
                title_escaped = v['title'][:65].replace('|', '\\|')
                channel_escaped = v['channel'][:30].replace('|', '\\|')
                f.write(f"| {v['score']} | {v['link']} | {title_escaped} | {v['word_count']} | {channel_escaped} |\n")
            f.write(f"\n")

    print(f"\nReport written to: {OUTPUT_FILE}", flush=True)
    print(f"Total candidates: {sum(len(v) for v in all_candidates.values())}", flush=True)


if __name__ == '__main__':
    main()
