# -*- coding: utf-8 -*-
"""Generate analysis JSON for cut_part4 from VTT."""
import re, json

vtt_path = 'data/cc-video/banking/_s1rIKaoAyM/cut_part4.clean.vtt'
out_path = 'data/cc-video/banking/_s1rIKaoAyM/cut_part4.analysis.json'

with open(vtt_path, encoding='utf-8') as f:
    text = f.read()

cue_pattern = re.compile(
    r'(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})[^\n]*\n(.*?)(?=\n\n|\n\d{2}:\d{2}|\Z)',
    re.DOTALL)

def parse_ts(ts):
    parts = ts.split(':')
    return int(parts[0])*3600 + int(parts[1])*60 + float(parts[2])

cues = []
for match in cue_pattern.finditer(text):
    start = round(parse_ts(match.group(1)), 3)
    end = round(parse_ts(match.group(2)), 3)
    body = match.group(3).strip().replace('\n', ' ')
    cues.append((start, end, body))

# Translations for all cues
translations = [
    "下一个词是expenditure，意思是花费的钱。同义词有spending、costs或outlay。",  # 0
    "这是一个名词，在Task 2写作中常与government expenditure或public expenditure搭配。",  # 1
    "Public expenditure就是government expenditure的另一种说法，因为政府用的是我们的公共资金。",  # 2
    "例如：Government expenditure on health care is increasing.（政府在医疗保健上的支出正在增加。）但不一定只用于政府支出，你也可以说公司支出，",  # 3
    "但我不建议用在个人花钱的语境中，那样不太合适。所以我们的学生写道：然而，机构的支出增加",  # 4
    "和员工的单调感是强制穿制服的主要弊端。他们在谈论公司花钱买制服。多么激动人心。",  # 5
    "用下一个词一定能超越你的目标分数。Exceed，意思是超出限制、标准或数字。同义词有surpass、go beyond或outdo。",  # 6
    "这是一个动词，常见搭配有exceed expectations或exceed a number。例如：The team managed to exceed expectations this quarter.（团队在本季度成功超越了预期。）",  # 7
    "在范文中：总之，现在很多运动员使用违禁药物来赢得比赛，他们能超越自身体能极限。",  # 8
    "下一个词我快速带过，因为它和我们已经讲过的bullying很相似——harassment，",  # 9
    "也就是bullying的同义词。意思是攻击性的施压或恐吓。同义词有bullying、intimidation或abuse。",  # 10
    "这是一个名词，常见搭配有workplace harassment和sexual harassment。bullying通常和学校相关，",  # 11
    "harassment通常更多与职场和社会相关，尽管bullying可以发生在任何地方。例如：The company has policies to prevent workplace harassment.",  # 12
    "在范文中：例如2016年，许多特朗普的支持者在报纸揭露他的性骚扰指控后对他失去了信任。",  # 13
    "使用这个词时要非常小心，因为我经常听到雅思学生在谈论困难事情时用harassment这个词。",  # 14
    "我收到过学生的邮件说雅思考试在harass他们，或者说我们在harass他们，因为我们",  # 15
    "给了他们低分，因为他们写作水平不太好。那不是harassment，那只是你的生活很困难因为你某方面不够好，通常是因为你懒。下一个词更像是连接词，",  # 16
    "它不算在词汇分里，而是算在你的衔接与连贯分里。但我还是提一下因为它很有用",  # 17
    "可以帮你提高衔接与连贯的分数。这个词是hence。",  # 18
    "基本意思是「因此」。同义词有therefore和thus。so在非正式口语中更常用，写作中少用。",  # 19
    "这是一个副词，常见搭配有hence the need或hence the need for。例如：The project is behind schedule, hence the need for extra workers.（项目落后于计划，因此需要额外人手。）",  # 20
    "你也可以在句首用它替代therefore，就像我们的学生写的：Hence, the more sports facilities will be available to the public,",  # 21
    "the more people could do sports and thus stay healthy. 他们在同一句话中用了两个therefore的同义词——hence和thus。",  # 22
    "但记住，连接词最重要的不是展示多少种类，而是用得准确恰当。",  # 23
    "如果你对连接词不确定，不要背50个然后随意塞进作文里。用一个简单但正确的词重复用，比换成一个错误的词要好。",  # 24
    "下一个词是informative，意思是提供有用信息的。同义词有educational、enlightening和instructive。",  # 25
    "这是一个形容词，通常用于教育语境中描述节目、课程、电视节目或纪录片等。",  # 26
    "例句：The lecture was very informative and helped me understand the topic better.（这场讲座信息量很大，帮我更好地理解了这个话题。）在范文中：看信息性和教育性",  # 27
    "节目的孩子学会了解决问题并培养了强大的心算能力。下一个词是infrastructure，意思是基本系统和结构。",  # 28
    "社会或组织运转所需的。同义词是system。这是一个名词。",  # 29
    "常见搭配有transport infrastructure和infrastructure projects。例句：Good transport infrastructure is essential for economic growth.（良好的交通基础设施对经济增长至关重要。）",  # 30
    "在范文中：总之，优先考虑经济增长的好处包括提高人们的生活质量和良好的基础设施。",  # 31
    "下一个词是insights，意思是对某事物的理解或认知。同义词有understandings、perceptions和intuition。",  # 32
    "这是一个名词，常见搭配有valuable insights和provide insights into。例如：The survey provided valuable insights into customer preferences.（调查提供了关于客户偏好的宝贵见解。）",  # 33
    "在范文中：学校的课程可以为孩子们提供关于如何成为社会好成员的宝贵见解。下一个词是insufficient，意思是不够的。",  # 34
    "通常与金钱或资源相关。同义词有inadequate、lacking和deficient。这是一个形容词，最常见的",  # 35
    "搭配是insufficient funds或insufficient resources。例如：The project was canceled due to insufficient funds.（项目因资金不足而取消。）",  # 36
    "在范文中：主要弊端是大多数人生活成本更高，以及对最贫困人群的支持不足。下一个词是innate。",  # 37
    "意思是与生俱来的或天生的。例如，呼吸的能力是innate的。同义词有inborn、inherent和natural。",  # 38
    "这是一个形容词，最常见的搭配是innate ability。例如：She has an innate ability to learn languages quickly.（她有天生的语言学习能力。）",  # 39
    "在范文中：一个人只有将天赋与努力结合，才能在职业中达到最高水平。你经常会遇到这样的问题——",  # 40
    "努力工作能带来成功吗？还是只有天生有某些才能的人才能成功？",  # 41
    "这时候你就可以用innate这个词。下一个词是inappropriate，意思是不适当的、不合适的。",  # 42
    "这是一种非常正式的表达「不好的」或「不对的」方式。同义词有unsuitable、improper和unfit。",  # 43
    "这是一个形容词，最常见的搭配是inappropriate behavior。常用来描述某人",  # 44
    "的行为不当。例如：His inappropriate behavior at the meeting was not acceptable.（他在会议上的不当行为是不可接受的。）",  # 45
    "在范文中：另一方面，总是穿制服的员工可能最终穿不适合其工作的衣服。下一个高级词汇是merit。",  # 46
    "意思是好的品质或价值。同义词有worth、value和excellence。",  # 47
    "这是一个名词，常见搭配有academic merit或on merit。记住这个词的好方法不是记它的意思，而是记它的反面。",  # 48
    "我相信你认识某个人靠关系得到工作，比如老板的侄子或",  # 49
    "老板的女儿——那不是based on merit，而是based on who they are。",  # 50
    "例句：Scholarships are often given based on academic merit.（奖学金通常基于学术成绩授予。）你凭自己的聪明才配得上奖学金。",  # 51
    "在范文中：作者完全不同意这个观点，因为选拔员工应该基于merit——他们的价值和工作能力。",  # 52
    "所以它不仅可以用在学术语境中，也可以用在更正式的职业语境中。下一个词是我最喜欢的词之一。",  # 53
    "它是mediocre，意思是不太好、相当普通。同义词有average、ordinary和so-so。",  # 54
    "如果你想非正式地表达，这是一个形容词。没有太多常见搭配，但记住它的好方式是——这是你能对别人说的最可怕的话之一。",  # 55
    "我是YouTube上很受欢迎的人，所以每天评论区都有人说难听的话。如果有人说我terrible或useless或Internet上最差的",  # 56
    "老师，我并不在意。但如果有人叫我mediocre，那就太伤人了。",  # 57
    "说你和所有人一样普通。例句：His performance was mediocre.（他的表现很平庸。）",  # 58
    "我们很多人都不得不挑战自己来超越平庸。在范文中，例如，世界上很多明星",  # 59
    "运动员一开始都是mediocre的，但他们挑战自己、突破极限，最终成为了最好的自己。",  # 60
    "如果你真的想惹我生气，就写「这个视频很mediocre」。下一个词是notable，意思是值得注意的或重要的。同义词有remarkable、significant或noteworthy。这是一个形容词",  # 61
    "常见搭配有notable achievement。如果你在谈论某人的成就、科学发现或技术进步，",  # 62
    "还有notable exception。如果你在表达观点后想提出反面论据，",  # 63
    "你可以说a notable exception is... 以及a notable example。你的作文中至少要给两个例子，所以可以用a notable example。这是一个",  # 64
    "例句：Her notable achievements in science earned her several awards.（她在科学方面的杰出成就为她赢得了多项奖项。）在范文中：总之，虽然知名人士从",  # 65
    "赞助商那里赚取大量金钱，但notable people的生命会因为心怀恶意的人而处于危险之中。下一个很有用的词是numerous，意思是很多的。",  # 66
    "数量很多。同义词有many、several、various，这是一个形容词。常见",  # 67
    "搭配有numerous times。例如：She has traveled to Paris numerous times.（她去过巴黎很多次。）在范文中，",  # 68
    "大多数商业组织的高层职位由男性占据，尽管事实上在许多发达国家中，超过一半的劳动力由",  # 69
    "女性组成。在使用这个词时，你可以在解释或举例时用它。解释时你可以说这已经发生了numerous times，或者",  # 70
    "有numerous examples。你不需要每篇作文都用，把它放在工具箱里就好。下一个词是peers，指同龄人。例如，",  # 71
    "我儿子的peers就是九岁的孩子，或者做同样工作、处于同一水平的人。",  # 72
    "他们有相同的地位。同义词有equals、colleagues和contemporaries。这是一个名词。",  # 73
    "常见搭配有peer pressure和their peers。我们经常在",  # 74
    "比较同一群体中的人时使用这个词。例如：Adolescents often face peer pressure from their peers to conform to group norms.（青少年经常面临来自同龄人的压力要求他们遵循群体规范。）在范文中，",  # 75
    "多项研究表明，观看教育类节目的孩子更有可能在考试中超越同龄人。非常适合用于比较、解释",  # 76
    "或举例。",  # 77
]

# Key points: indices and their data
key_data = {
    0: ("expenditure", "支出/经费。发音 /ɪkˈspendɪtʃər/，重音在第二音节。比 spending 更正式，常用于政府和企业层面。核心搭配：government expenditure（政府支出）、public expenditure（公共支出）。例：Government expenditure on education should be increased.（政府在教育上的支出应该增加。）", "expenditure"),
    1: ("government expenditure", "政府支出/财政支出。雅思Task 1图表题和Task 2讨论政府政策时的核心搭配。也可写作 public expenditure。例：Government expenditure on infrastructure has doubled over the past decade.", "government expenditure"),
    6: ("Exceed", "超越/超出。发音 /ɪkˈsiːd/，重音在第二音节。核心搭配：exceed expectations（超越预期）、exceed the limit（超过限制）。例：The results exceeded all expectations.（结果超出了所有预期。）", "超出"),
    7: ("exceed expectations", "超越预期。在雅思写作中讨论成就、目标或经济指标时非常有用。例：The company's revenue exceeded expectations for the third consecutive quarter.", "exceed expectations"),
    11: ("workplace harassment", "职场骚扰。与school bullying对比：bullying偏指校园中的欺凌，harassment偏指职场和社会中的骚扰。常见搭配还有：sexual harassment（性骚扰）。例：Companies must implement policies to prevent workplace harassment.", "workplace harassment"),
    18: ("hence", "因此/所以。比therefore更简洁，常用于学术写作。核心搭配：hence the need for（因此需要）。可以放在句首或句中。例：The population is aging, hence the need for more healthcare funding.（人口老龄化，因此需要更多的医疗资金。）", "hence"),
    25: ("informative", "信息丰富的/有教育意义的。发音 /ɪnˈfɔːrmətɪv/。常用于描述讲座、纪录片、节目等。例：The documentary was highly informative and thought-provoking.（这部纪录片信息量很大且发人深省。）", "informative"),
    28: ("infrastructure", "基础设施。发音 /ˈɪnfrəstrʌktʃər/，重音在第一音节。核心搭配：transport infrastructure（交通基础设施）、infrastructure projects（基建项目）。雅思写作中讨论城市发展、经济增长时必备。例：Developing countries need to invest in infrastructure to attract foreign investment.", "infrastructure"),
    33: ("valuable insights", "宝贵的见解/深刻的认识。在雅思写作中用于描述从研究、经验或教育中获得的知识。例：The research provides valuable insights into consumer behavior.（这项研究提供了关于消费者行为的宝贵见解。）", "valuable insights"),
    34: ("insufficient", "不足的/不够的。发音 /ˌɪnsəˈfɪʃnt/。比 not enough 更正式。核心搭配：insufficient funds（资金不足）、insufficient resources（资源不足）。例：Many schools have insufficient resources to support special needs students.", "insufficient"),
    39: ("innate ability", "天赋/与生俱来的能力。innate 发音 /ɪˈneɪt/。在雅思写作中讨论天赋与努力的话题时核心词汇。例：While innate ability plays a role, hard work is equally important for success.", "innate ability"),
    44: ("inappropriate behavior", "不当行为。在雅思写作中讨论行为规范、职场文化等话题时常用。inappropriate 比 bad 或 wrong 更正式。例：Schools should have clear policies to address inappropriate behavior.", "inappropriate behavior"),
    46: ("merit", "功绩/优点/价值。发音 /ˈmerɪt/。核心搭配：academic merit（学术成绩）、on merit/based on merit（凭能力/凭本事）。讨论公平、选拔制度时的关键词。例：Employees should be promoted based on merit, not connections.（员工应凭能力晋升，而非靠关系。）", "merit"),
    54: ("mediocre", "平庸的/中等偏下的。发音 /ˌmiːdiˈoʊkər/，重音在第三音节。比 average 带有更强的负面含义，暗示「不够好」。例：A mediocre performance will not be enough to secure a scholarship.（平庸的表现不足以获得奖学金。）", "mediocre"),
    8: ("exceed", "这里指运动员通过药物超越自身极限。exceed + 抽象名词（capabilities/limits/expectations）是常见句型。注意不能说 exceed over，直接 exceed sth 就行。", "超越"),
    13: ("sexual harassment", "性骚扰。这是 harassment 最高频的搭配之一。注意 harassment 发音 /həˈræsmənt/（美式）或 /ˈhærəsmənt/（英式），重音位置不同。雅思写作中讨论社会问题时可用。", "性骚扰"),
    30: ("transport infrastructure", "交通基础设施。雅思写作中讨论城市发展、政府投资时的核心搭配。也可说 transportation infrastructure（美式）。例：Investing in transport infrastructure boosts regional economic growth.", "交通基础设施"),
    36: ("insufficient funds", "资金不足。正式表达，常见于商业和学术语境。也可说 insufficient funding。注意 insufficient 发音 /ˌɪnsəˈfɪʃnt/，重音在第三音节。", "资金不足"),
    50: ("based on merit", "凭能力/凭实力。与 based on connections/nepotism（裙带关系）形成对比。在讨论公平选拔、招聘制度时的核心表达。例：All promotions in this company are based on merit.", "based on merit"),
    62: ("notable", "显著的/值得注意的。发音 /ˈnoʊtəbl/。核心搭配：notable achievement（杰出成就）、notable exception（显著例外）、notable example（典型例子）。例：A notable exception to this trend is Japan, where birth rates continue to decline.", "notable achievement"),
    63: ("notable exception", "显著例外。写作中提出反面论据时的高级表达。结构：A notable exception is...（一个显著的例外是……）。比 but/however 更学术化。例：A notable exception is Finland, where students perform well despite fewer school hours.", "notable exception"),
    66: ("numerous", "众多的/大量的。比 many 更正式。常见搭配：numerous times（多次）、numerous examples（大量例子）、numerous studies（大量研究）。例：Numerous studies have shown that exercise improves mental health.", "numerous"),
    71: ("peers", "同龄人/同辈。发音 /pɪrz/。核心搭配：peer pressure（同辈压力）、their peers（他们的同龄人）、outperform their peers（超越同龄人）。在雅思写作中讨论教育、青少年话题时高频出现。例：Children learn social skills by interacting with their peers.", "peers"),
    75: ("peer pressure", "同辈压力/同龄人压力。青少年话题中的核心概念。指来自同龄群体的社会压力，迫使个人做出一致行为。例：Peer pressure can lead teenagers to make poor decisions.（同辈压力可能导致青少年做出不好的决定。）", "peer pressure"),
}

subs = []
for i, (start, end, txt) in enumerate(cues):
    sub = {
        "time": start,
        "endTime": end,
        "text": txt,
        "translation": translations[i] if i < len(translations) else "",
        "isKeyPoint": i in key_data,
        "highlightWords": [key_data[i][0]] if i in key_data else [],
        "keyNotes": {key_data[i][0]: key_data[i][1]} if i in key_data else {},
        "highlightTranslations": {key_data[i][0]: key_data[i][2]} if i in key_data else {},
    }
    subs.append(sub)

data = {
    "sceneContext": "The user is an IELTS student preparing for the writing exam, working with a vocabulary coach. They need to learn and practice using advanced vocabulary words (expenditure, exceed, harassment, hence, informative, infrastructure, insights, insufficient, innate, inappropriate, merit, mediocre, notable, numerous, peers) with proper collocations for IELTS Task 2 essays.",
    "subtitles": subs,
    "keyPhrases": [
        {"expression": "government expenditure", "meaningZh": "政府支出", "usage": "Formal term for government spending, used in essays about public policy and economics", "register": "formal", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "exceed expectations", "meaningZh": "超越预期", "usage": "Used to describe surpassing predicted results or standards", "register": "formal", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "workplace harassment", "meaningZh": "职场骚扰", "usage": "Aggressive behavior in professional settings, distinct from school bullying", "register": "formal", "speakerRole": "both", "minDifficulty": "MEDIUM"},
        {"expression": "hence the need for", "meaningZh": "因此需要", "usage": "A formal linking phrase used to explain a consequence or necessity", "register": "formal", "speakerRole": "learner", "minDifficulty": "HARD"},
        {"expression": "innate ability", "meaningZh": "天赋/与生俱来的能力", "usage": "Natural talent present from birth, used in nature vs nurture discussions", "register": "formal", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "based on merit", "meaningZh": "凭能力/凭本事", "usage": "Selection or reward based on quality and achievement rather than connections", "register": "formal", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "notable achievement", "meaningZh": "杰出成就", "usage": "Used to highlight significant accomplishments in examples and arguments", "register": "formal", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "peer pressure", "meaningZh": "同辈压力", "usage": "Social influence from same-age group members, common in education and adolescence topics", "register": "formal", "speakerRole": "both", "minDifficulty": "EASY"},
        {"expression": "insufficient resources", "meaningZh": "资源不足", "usage": "Describes a lack of necessary materials, funding, or support", "register": "formal", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "valuable insights", "meaningZh": "宝贵的见解", "usage": "Used to describe useful understanding gained from research, experience, or education", "register": "formal", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
    ],
    "roleSetup": {"name": "Chris", "identity": "IELTS writing instructor and vocabulary coach", "personality": "enthusiastic, humorous, knowledgeable", "accent": "American"},
    "complications": {
        "medium": [
            "The student confuses 'expenditure' (formal, for organizations/governments) with 'spending' (general) and uses it for personal purchases",
            "The student misuses 'harassment' to describe any difficult situation rather than its specific meaning of aggressive pressure or intimidation"
        ],
        "hard": [
            "The student must write an IELTS body paragraph about government investment in infrastructure, correctly using expenditure, insufficient, infrastructure, and hence with appropriate collocations",
            "The student needs to construct an argument about talent vs effort using innate ability, mediocre, exceed expectations, and merit while maintaining academic register"
        ]
    },
    "maxRounds": {"easy": 4, "medium": 6, "hard": 10},
    "commonErrors": [
        "expenditure 用于个人消费语境（应只用于政府/公司层面的支出）",
        "harassment 和 difficulty 混淆，考试难不是 harassment",
        "hence 放在句中位置不对，应该像 therefore 一样用在表因果关系的地方",
        "innate 和 inherent 混淆，前者强调天生的，后者强调固有的特性"
    ],
    "culturalNotes": "在雅思写作中，merit-based（基于能力的）选拔制度是西方社会的核心价值观之一。讨论公平性话题时，能够准确使用 merit、qualifications、competence 等词汇会显示你对西方社会价值观的理解。同时，peer pressure 在西方教育讨论中是一个被广泛研究的概念，了解它的含义和用法对写教育类作文非常有帮助。",
    "country": "US"
}

with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

kp = sum(1 for s in subs if s['isKeyPoint'])
print(f'Generated: {len(subs)} subs, {kp} key points ({kp*100//len(subs)}%)')
