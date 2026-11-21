import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@openbot/ui";

/** A settings row with a title, a hint and a menu of choices. */
export function ChoiceRow(props: {
  id: string;
  title: string;
  hint: string;
  options: string[];
  value: string;
  label: (value: string) => string;
  disabled: boolean;
  menuMount: HTMLElement | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <Item>
      <ItemContent>
        <ItemTitle id={`${props.id}-label`}>{props.title}</ItemTitle>
        <ItemDescription>{props.hint}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Select<string>
          options={props.options}
          value={props.value}
          disabled={props.disabled}
          placement="bottom-end"
          sameWidth={false}
          onChange={(value) => {
            if (value && value !== props.value) props.onChange(value);
          }}
          itemComponent={(item) => <SelectItem item={item.item}>{props.label(item.item.rawValue)}</SelectItem>}
        >
          <SelectTrigger size="sm" aria-labelledby={`${props.id}-label`}>
            <SelectValue<string>>{(selected) => props.label(selected.selectedOption() ?? props.value)}</SelectValue>
          </SelectTrigger>
          <SelectContent mount={props.menuMount} />
        </Select>
      </ItemActions>
    </Item>
  );
}
