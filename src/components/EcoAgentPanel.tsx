import { useMemo, useState } from 'react';
import { Bot, FilePlus2, Send, Sparkles } from 'lucide-react';

type AgentStep = 'document' | 'sources' | 'draft' | 'corrections';

interface EcoAgentPanelProps {
  onApplyDraft: (content: string) => void;
}

interface AgentMessage {
  id: number;
  role: 'agent' | 'user';
  text: string;
}

const initialMessages: AgentMessage[] = [
  {
    id: 1,
    role: 'agent',
    text:
      'Здравствуйте. Я ИИ-агент — разработчик экологической документации. ' +
      'Какую документацию необходимо разработать?',
  },
];

function buildDraft(documentRequest: string, sources: string): string {
  return `# ${documentRequest}

## 1. Назначение документа

Документ разработан для описания экологических аспектов деятельности, оценки потенциального воздействия на окружающую среду и фиксации природоохранных мероприятий.

## 2. Исходные данные

${sources}

## 3. Описание объекта и деятельности

Необходимо уточнить сведения об объекте, технологических процессах, применяемом оборудовании, источниках выбросов, сбросов, образования отходов и потребления природных ресурсов.

## 4. Экологические аспекты

| Аспект | Источник информации | Требуемая проработка |
|--------|---------------------|----------------------|
| Атмосферный воздух | Исходные данные заказчика | Проверить источники выбросов и загрязняющие вещества |
| Водные ресурсы | Схемы водопотребления и водоотведения | Описать сбросы, лимиты и контроль |
| Отходы | Инвентаризация отходов | Указать классы опасности, объемы и способы обращения |
| Почвы и территория | Материалы обследования | Оценить риски загрязнения и меры защиты |

## 5. Природоохранные мероприятия

- Организовать производственный экологический контроль.
- Обеспечить учет образования, накопления и передачи отходов.
- Контролировать соблюдение нормативов выбросов и сбросов.
- Поддерживать актуальность разрешительной и отчетной документации.

## 6. Перечень недостающих сведений

- Реквизиты и адрес объекта.
- Технологическое описание процессов.
- Количественные показатели выбросов, сбросов и отходов.
- Действующие разрешения, лимиты, договоры и протоколы измерений.

## 7. Вывод

После предоставления полного комплекта исходных данных документ может быть доработан до финальной редакции с учетом требований применимого экологического законодательства.`;
}

function applyCorrections(draft: string, corrections: string): string {
  return `${draft}

## 8. Внесенные корректировки

${corrections}

## 9. Актуализированная редакция

Корректировки учтены при дальнейшей подготовке экологической документации. Перед выпуском документа рекомендуется проверить числовые показатели, ссылки на нормативные требования и комплект приложений.`;
}

export function EcoAgentPanel({ onApplyDraft }: EcoAgentPanelProps) {
  const [messages, setMessages] = useState<AgentMessage[]>(initialMessages);
  const [step, setStep] = useState<AgentStep>('document');
  const [input, setInput] = useState('');
  const [documentRequest, setDocumentRequest] = useState('');
  const [sources, setSources] = useState('');
  const [draft, setDraft] = useState('');

  const placeholder = useMemo(() => {
    switch (step) {
      case 'document':
        return 'Например: Паспорт отходов, ПНООЛР, отчет ПЭК...';
      case 'sources':
        return 'Опишите исходные данные, ссылки, файлы, протоколы, реквизиты объекта...';
      case 'corrections':
        return 'Напишите, что нужно изменить или добавить...';
      case 'draft':
        return 'Проект готов — можно внести его в документ или запросить корректировки';
    }
  }, [step]);

  function addMessage(role: AgentMessage['role'], text: string) {
    setMessages((current) => [
      ...current,
      { id: Date.now() + current.length, role, text },
    ]);
  }

  function handleSubmit() {
    const value = input.trim();
    if (!value || step === 'draft') return;

    addMessage('user', value);
    setInput('');

    if (step === 'document') {
      setDocumentRequest(value);
      setStep('sources');
      addMessage(
        'agent',
        'Принято. Укажите источники информации: исходные данные, реквизиты объекта, протоколы, разрешения, ссылки, требования заказчика или выдержки из файлов.'
      );
      return;
    }

    if (step === 'sources') {
      const generatedDraft = buildDraft(documentRequest, value);
      setSources(value);
      setDraft(generatedDraft);
      setStep('draft');
      addMessage(
        'agent',
        `Разработал проект документа «${documentRequest}». Проверьте структуру, внесите проект в редактор или запросите корректировки.`
      );
      return;
    }

    const correctedDraft = applyCorrections(draft, value);
    setDraft(correctedDraft);
    setStep('draft');
    addMessage(
      'agent',
      'Корректировки внесены. Обновленную редакцию можно перенести в текущий документ.'
    );
  }

  function requestCorrections() {
    setStep('corrections');
    addMessage(
      'agent',
      'Какие корректировки внести? Укажите замечания, новые исходные данные или нужные формулировки.'
    );
  }

  function restartDialog() {
    setMessages(initialMessages);
    setStep('document');
    setInput('');
    setDocumentRequest('');
    setSources('');
    setDraft('');
  }

  return (
    <aside className="eco-agent">
      <div className="eco-agent-header">
        <div>
          <span className="eco-agent-eyebrow">ИИ-агент</span>
          <h2>Экологическая документация</h2>
        </div>
        <Bot size={22} />
      </div>

      <div className="eco-agent-role">
        <Sparkles size={16} />
        <span>
          Роль: разработчик экологической документации. Общение ведется на русском языке.
        </span>
      </div>

      <div className="eco-agent-messages">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`eco-agent-message ${message.role === 'agent' ? 'agent' : 'user'}`}
          >
            {message.text}
          </div>
        ))}
      </div>

      {draft && (
        <div className="eco-agent-draft">
          <div className="eco-agent-draft-title">Проект готов</div>
          <p>
            Источники учтены: {sources.length > 90 ? `${sources.slice(0, 90)}...` : sources}
          </p>
          <button className="btn btn-primary btn-sm" onClick={() => onApplyDraft(draft)}>
            <FilePlus2 size={14} />
            <span>Внести в документ</span>
          </button>
          <button className="btn btn-secondary btn-sm" onClick={requestCorrections}>
            Запросить корректировки
          </button>
        </div>
      )}

      <div className="eco-agent-input">
        <textarea
          value={input}
          placeholder={placeholder}
          disabled={step === 'draft'}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              handleSubmit();
            }
          }}
        />
        <div className="eco-agent-actions">
          <button className="btn btn-secondary btn-sm" onClick={restartDialog}>
            Новый запрос
          </button>
          <button
            className="btn btn-primary btn-sm"
            disabled={!input.trim() || step === 'draft'}
            onClick={handleSubmit}
          >
            <Send size={14} />
            <span>Отправить</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
