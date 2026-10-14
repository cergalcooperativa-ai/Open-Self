/**
 * `openself feed` — Feed chat history to build personality
 */

import chalk from 'chalk';
import ora from 'ora';
import { parseWhatsApp, splitBySender, detectUserName } from '../parsers/whatsapp.js';
import { parseTelegram } from '../parsers/telegram.js';
import { parseGeneric } from '../parsers/generic.js';
import { extractPersonality } from '../personality/extractor.js';
import { createFingerprint } from '../personality/fingerprint.js';
import { generateSoulMd, saveSoulMd } from '../personality/soul-generator.js';
// Mesmo store que o gateway le (data/memory-index/vectors.json + metadata.json)
import { ChatMemory } from '../memory/rag.js';
import inquirer from 'inquirer';
import { writeFileSync, existsSync, readFileSync } from 'fs';

export async function feedCommand(options) {
    console.log('');
    console.log(chalk.bold.cyan('🧠 OpenSelf — Feed Personality'));
    console.log(chalk.gray('━'.repeat(40)));
    console.log('');

    const allMessages = [];
    let userName = options.name || process.env.OPENSELF_USER_NAME || '';
    const contactMap = {};

    // Parse WhatsApp files
    if (options.whatsapp) {
        for (const file of options.whatsapp) {
            const spinner = ora(`Parsing WhatsApp export: ${file}`).start();
            try {
                const messages = parseWhatsApp(file);
                allMessages.push(...messages);
                spinner.succeed(`Parsed ${messages.length} messages from ${file}`);
            } catch (err) {
                spinner.fail(`Failed to parse ${file}: ${err.message}`);
            }
        }
    }

    // Parse Telegram files
    if (options.telegram) {
        for (const file of options.telegram) {
            const spinner = ora(`Parsing Telegram export: ${file}`).start();
            try {
                const messages = parseTelegram(file);
                allMessages.push(...messages);
                spinner.succeed(`Parsed ${messages.length} messages from ${file}`);
            } catch (err) {
                spinner.fail(`Failed to parse ${file}: ${err.message}`);
            }
        }
    }

    // Parse manual personality briefs
    if (options.manual) {
        for (const file of options.manual) {
            const spinner = ora(`Reading personality brief: ${file}`).start();
            try {
                const personality = parseGeneric(file);
                spinner.succeed(`Read personality brief from ${file}`);
                // Manual briefs get saved directly
                console.log(
                    chalk.gray(`  Sections: ${Object.keys(personality.sections).join(', ')}`),
                );
            } catch (err) {
                spinner.fail(`Failed to read ${file}: ${err.message}`);
            }
        }
    }

    if (allMessages.length === 0 && !options.manual) {
        console.log(chalk.red('\n❌ No messages found. Please provide chat export files.'));
        console.log(chalk.yellow('   npx openself feed --whatsapp ./chat-export.txt'));
        return;
    }

    // Detect or ask for user name
    if (!userName && allMessages.length > 0) {
        const detected = detectUserName(allMessages);
        console.log('');
        console.log(chalk.white('Detected senders:'));
        for (const sender of detected.allSenders.slice(0, 5)) {
            console.log(chalk.gray(`  • ${sender.name} (${sender.count} messages)`));
        }

        const { selectedName } = await inquirer.prompt([
            {
                type: 'list',
                name: 'selectedName',
                message: 'Which one is YOU?',
                choices: detected.allSenders.slice(0, 10).map((s) => s.name),
            },
        ]);
        userName = selectedName;
    }

    if (allMessages.length > 0) {
        // Split messages
        const spinnerAnalyze = ora('Analyzing your personality...').start();
        const { yours, others, conversations } = splitBySender(allMessages, userName);

        // Build contact map
        for (const msg of others) {
            if (!contactMap[msg.sender]) {
                contactMap[msg.sender] = {
                    name: msg.sender,
                    messageCount: 0,
                    relationship: 'Contact',
                };
            }
            contactMap[msg.sender].messageCount++;
        }

        // Extract personality
        const personality = extractPersonality(yours, conversations);
        const fingerprint = createFingerprint(yours.map((m) => m.text));

        spinnerAnalyze.succeed('Personality analysis complete');

        // Show summary
        console.log('');
        console.log(chalk.bold.white('📊 Personality Summary'));
        console.log(chalk.gray('━'.repeat(40)));
        console.log(
            chalk.white(`  📝 Total messages analyzed: ${chalk.cyan(personality.totalMessages)}`),
        );
        console.log(
            chalk.white(
                `  📏 Avg message length: ${chalk.cyan(personality.avgMessageLength)} chars`,
            ),
        );
        console.log(
            chalk.white(
                `  😀 Emoji frequency: ${chalk.cyan(Math.round(personality.emojiFrequency * 100) + '%')}`,
            ),
        );
        console.log(chalk.white(`  🗣️  Formality: ${chalk.cyan(personality.formality)}`));
        console.log(chalk.white(`  🌍 Language: ${chalk.cyan(personality.primaryLanguage)}`));
        console.log(chalk.white(`  😂 Humor: ${chalk.cyan(personality.humorPatterns.join(', '))}`));
        console.log(chalk.white(`  👋 Greeting style: ${chalk.cyan(personality.greetingStyle)}`));

        if (personality.catchphrases.length > 0) {
            console.log(
                chalk.white(
                    `  💬 Catchphrases: ${chalk.cyan(personality.catchphrases.slice(0, 5).join(', '))}`,
                ),
            );
        }
        if (personality.abbreviations.length > 0) {
            console.log(
                chalk.white(
                    `  ✂️  Abbreviations: ${chalk.cyan(personality.abbreviations.slice(0, 5).join(', '))}`,
                ),
            );
        }
        if (personality.pronounUsage.length > 0) {
            console.log(
                chalk.white(`  🇻🇳 Pronouns: ${chalk.cyan(personality.pronounUsage.join(', '))}`),
            );
        }

        // Generate SOUL.md
        console.log('');
        const spinnerSoul = ora('Generating SOUL.md...').start();
        const soulContent = generateSoulMd(personality, fingerprint, {
            name: userName,
            contacts: contactMap,
        });
        // Preserva SOUL.md curado manualmente: se ja existe, a versao nova
        // vai para SOUL.auto.md; ajustes manuais de idioma/limites/relacionamentos
        // nao sao mais apagados por novos feeds.
        let soulPath;
        if (existsSync('./data/SOUL.md')) {
            writeFileSync('./data/SOUL.auto.md', soulContent, 'utf-8');
            soulPath = './data/SOUL.auto.md';
            spinnerSoul.succeed('SOUL.auto.md regenerated (curated SOUL.md preserved)');
        } else {
            soulPath = saveSoulMd(soulContent);
            spinnerSoul.succeed(`SOUL.md generated at ${chalk.cyan(soulPath)}`);
        }

        // Save conversations for clone testing
        const conversationsForTest = conversations.slice(0, 100); // Keep top 100
        const { mkdirSync } = await import('fs');
        const dataDir = './data';
        if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
        writeFileSync(
            `${dataDir}/conversations.json`,
            JSON.stringify(conversationsForTest, null, 2),
            'utf-8',
        );

        // Persist structured personality so mimicry/style modules can read
        // the trained numeric stats at runtime (SOUL.md alone loses them).
        writeFileSync(
            `${dataDir}/personality.json`,
            JSON.stringify({ ...personality, fingerprint, userName }, null, 2),
            'utf-8',
        );

        // Per-contact style profiles: each conversation has its own register.
        // Derives tone/length signature per contact from the actual chats.
        const perContact = {};
        for (const [name, info] of Object.entries(contactMap)) {
            const convs = conversations.filter((c) => c.contact === name);
            if (!convs.length) continue;
            const replies = convs.map((c) => c.yourReply || '');
            const avgWords =
                replies.reduce((a, r) => a + r.split(/\s+/).filter(Boolean).length, 0) /
                replies.length;
            const words = {};
            for (const r of replies) {
                for (const w of r.toLowerCase().match(/\p{L}{3,}/gu) || []) {
                    words[w] = (words[w] || 0) + 1;
                }
            }
            const topWords = Object.entries(words)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 15)
                .map(([w]) => w);
            perContact[name] = {
                messageCount: info.messageCount,
                relationship: info.relationship || 'Contact',
                avgReplyWords: Math.round(avgWords * 10) / 10,
                topWordsWithThisContact: topWords,
                rules: `Fale com ${name} do mesmo jeito que você fala nos exemplos. Vocabulário típico com ${name}: ${topWords.slice(0, 10).join(', ')}. Média de ${Math.round(avgWords)} palavras por resposta.`,
            };
        }
        // merge: preserva perfis de contatos de feeds anteriores
        let existingContacts = {};
        try {
            existingContacts = JSON.parse(readFileSync(`${dataDir}/contacts.json`, 'utf-8'));
        } catch {
            // primeiro feed — arquivo não existe ainda
        }
        writeFileSync(
            `${dataDir}/contacts.json`,
            JSON.stringify({ ...existingContacts, ...perContact }, null, 2),
            'utf-8',
        );

        // RAG indexing — auto-index conversations for memory
        if (conversations.length > 0) {
            const spinnerRAG = ora('Indexing memories for RAG search...').start();
            try {
                const memory = new ChatMemory(dataDir);
                const before = (await memory.init(), memory.metadata.length);
                await memory.indexHistory(conversations, { dedupe: true });
                const stats = memory.getStats();
                spinnerRAG.succeed(
                    `Indexed ${chalk.cyan(stats.totalMemories - before)} new memories for RAG search (${chalk.gray(stats.totalMemories + ' total')})`,
                );
            } catch (err) {
                spinnerRAG.warn(`RAG indexing skipped: ${err.message}`);
            }
        }

        console.log('');
        console.log(chalk.bold.green('🎉 Personality fed successfully!'));
        console.log('');
        console.log(chalk.white('Next:'));
        console.log(
            chalk.yellow('  npx openself test       ') +
                chalk.gray('— Test how well your clone mimics you'),
        );
        console.log(
            chalk.yellow('  npx openself arena      ') +
                chalk.gray('— Watch your clone debate a rival'),
        );
        console.log(
            chalk.yellow('  cat data/SOUL.md        ') +
                chalk.gray('— Review/edit your personality profile'),
        );
        console.log('');
    }
}
