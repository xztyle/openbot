import type { GuardrailChainChoice, GuardrailProvider } from "@openbot/contracts/guardrails";
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SettingsRow } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { For } from "solid-js";

export interface ChainModel {
  id: string;
  name: string;
  provider: GuardrailProvider;
}

const keyOf = (provider: string, model: string) => `${provider}:${model}`;

/**
 * An ordered list of fallback models: each row has its model, move up, move down and remove, and the
 * last row adds one more. An empty list means "nothing set" (the caller shows the built-in order).
 */
export function TrustFailoverChain(props: {
  title: string;
  description?: string | undefined;
  chain: GuardrailChainChoice[];
  models: ChainModel[];
  onChange: (chain: GuardrailChainChoice[]) => void;
}) {
  const { t } = useText();
  const label = (key: string | null) => {
    const found = props.models.find((model) => keyOf(model.provider, model.id) === key);
    if (found) return `${found.name}`;
    return key?.split(":").slice(1).join(":") ?? "";
  };
  const options = () => props.models.map((model) => keyOf(model.provider, model.id));
  const parse = (key: string): GuardrailChainChoice | null => {
    const model = props.models.find((candidate) => keyOf(candidate.provider, candidate.id) === key);
    return model ? { provider: model.provider, model: model.id } : null;
  };
  const move = (index: number, by: -1 | 1) => {
    const next = [...props.chain];
    const [item] = next.splice(index, 1);
    if (!item) return;
    next.splice(index + by, 0, item);
    props.onChange(next);
  };
  const picker = (value: string | null, onPick: (key: string) => void, aria: string) => (
    <Select<string>
      options={options()}
      value={value}
      onChange={(key) => key && onPick(key)}
      placement="bottom-end"
      itemComponent={(selectProps) => (
        <SelectItem item={selectProps.item}>{label(selectProps.item.rawValue)}</SelectItem>
      )}
    >
      <SelectTrigger size="sm" aria-label={aria}>
        <SelectValue<string>>{(state) => label(state.selectedOption())}</SelectValue>
      </SelectTrigger>
      <SelectContent />
    </Select>
  );
  return (
    <>
      <SettingsRow layout="inline" label={props.title} description={props.description} />
      <For each={props.chain}>
        {(step, index) => (
          <SettingsRow layout="inline" label={t("trust.guardrails.chain.step", { n: String(index() + 1) })}>
            {picker(
              keyOf(step.provider, step.model),
              (key) => {
                const choice = parse(key);
                if (choice) props.onChange(props.chain.map((entry, i) => (i === index() ? choice : entry)));
              },
              t("trust.guardrails.chain.step", { n: String(index() + 1) }),
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={index() === 0}
              aria-label={t("trust.guardrails.chain.up")}
              onClick={() => move(index(), -1)}
            >
              {t("trust.guardrails.chain.up")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={index() === props.chain.length - 1}
              aria-label={t("trust.guardrails.chain.down")}
              onClick={() => move(index(), 1)}
            >
              {t("trust.guardrails.chain.down")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => props.onChange(props.chain.filter((_, i) => i !== index()))}
            >
              {t("trust.guardrails.chain.remove")}
            </Button>
          </SettingsRow>
        )}
      </For>
      <SettingsRow layout="inline" label={t("trust.guardrails.chain.add")}>
        {picker(
          null,
          (key) => {
            const choice = parse(key);
            if (choice && props.chain.length < 8) props.onChange([...props.chain, choice]);
          },
          t("trust.guardrails.chain.add"),
        )}
      </SettingsRow>
    </>
  );
}
