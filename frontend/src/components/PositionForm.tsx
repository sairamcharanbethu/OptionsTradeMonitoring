import React from 'react';
import { useForm, SubmitHandler } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { CalendarIcon, Check, ChevronsUpDown } from "lucide-react";
import { api, Position } from '@/lib/api';

const STOCKS = [
  { label: "SPY", value: "SPY" },
  { label: "QQQ", value: "QQQ" },
  { label: "IWM", value: "IWM" },
  { label: "AAPL", value: "AAPL" },
  { label: "NVDA", value: "NVDA" },
  { label: "TSLA", value: "TSLA" },
  { label: "AMD", value: "AMD" },
  { label: "AMZN", value: "AMZN" },
  { label: "MSFT", value: "MSFT" },
  { label: "GOOGL", value: "GOOGL" },
  { label: "META", value: "META" },
  { label: "NFLX", value: "NFLX" },
  { label: "BABA", value: "BABA" },
  { label: "PLTR", value: "PLTR" },
  { label: "COIN", value: "COIN" },
  { label: "MSTR", value: "MSTR" },
  { label: "INTC", value: "INTC" },
  { label: "DIS", value: "DIS" },
  { label: "JPM", value: "JPM" },
  { label: "BA", value: "BA" },
  // Add more as needed
] as const;

const formSchema = z.object({
  symbol: z.string().min(1, 'Symbol is required').toUpperCase(),
  option_type: z.enum(['CALL', 'PUT']),
  strike_price: z.coerce.number().positive(),
  expiration_date: z.date(),
  entry_price: z.coerce.number().positive(),
  quantity: z.coerce.number().int().positive(),
  trailing_stop_loss_pct: z.coerce.number().positive().optional(),
});

type FormValues = z.infer<typeof formSchema>;

export default function PositionForm({ onSuccess, position }: { onSuccess: () => void, position?: Position }) {
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema) as any,
    defaultValues: position ? {
      symbol: position.symbol,
      option_type: position.option_type,
      strike_price: position.strike_price,
      expiration_date: new Date(position.expiration_date),
      entry_price: position.entry_price,
      quantity: position.quantity,
      trailing_stop_loss_pct: position.trailing_stop_loss_pct || 10,
    } : {
      symbol: '',
      option_type: 'CALL',
      quantity: 1,
      trailing_stop_loss_pct: 10,
    },
  });

  const [open, setOpen] = React.useState(false);
  const [inputValue, setInputValue] = React.useState("");

  const onSubmit: SubmitHandler<FormValues> = async (values) => {
    // Format date to YYYY-MM-DD for backend
    const payload = {
        ...values,
        expiration_date: format(values.expiration_date, "yyyy-MM-dd"), // Correct format for backend
    };

    try {
      if (position) {
        await api.updatePosition(position.id, payload);
      } else {
        await api.createPosition(payload);
      }
      form.reset();
      onSuccess();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit as any)} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="symbol"
            render={({ field }) => (
              <FormItem className="flex flex-col">
                <FormLabel>Symbol</FormLabel>
                <Popover open={open} onOpenChange={setOpen}>
                  <PopoverTrigger asChild>
                    <FormControl>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={open}
                        className={cn(
                          "w-full justify-between h-10",
                          !field.value && "text-muted-foreground"
                        )}
                      >
                        {field.value
                          ? field.value
                          : "Select stock"}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </FormControl>
                  </PopoverTrigger>
                  <PopoverContent className="w-[200px] p-0">
                    <Command shouldFilter={false}>
                      <CommandInput 
                        placeholder="Search stock..." 
                        value={inputValue}
                        onValueChange={(val: string) => setInputValue(val)}
                      />
                      <CommandList>
                         {STOCKS.filter(stock => !inputValue || stock.label.toLowerCase().includes(inputValue.toLowerCase())).length === 0 && !inputValue && (
                             <CommandEmpty>No stock found.</CommandEmpty>
                         )}
                         <CommandGroup>
                            {STOCKS.filter(stock => !inputValue || stock.label.toLowerCase().includes(inputValue.toLowerCase())).map((stock) => (
                            <CommandItem
                                value={stock.label} // Use label for value to match visual
                                key={stock.value}
                                onSelect={(currentValue: string) => {
                                    // With manual filtering and value matching label, direct assignment is safer
                                    // But keep robust find just in case
                                    const selected = STOCKS.find((s) => s.label.toLowerCase() === currentValue.toLowerCase());
                                    if (selected) {
                                        form.setValue("symbol", selected.value);
                                        setOpen(false);
                                    } else {
                                        // Fallback using the passed value directly if find fails
                                        form.setValue("symbol", currentValue.toUpperCase());
                                        setOpen(false);
                                    }
                                }}
                            >
                                <Check
                                className={cn(
                                    "mr-2 h-4 w-4",
                                    stock.value === field.value
                                    ? "opacity-100"
                                    : "opacity-0"
                                )}
                                />
                                {stock.label}
                            </CommandItem>
                            ))}
                            {/* Dynamic "Create" Item */}
                            {inputValue && !STOCKS.some(s => s.label.toLowerCase() === inputValue.toLowerCase()) && (
                                <CommandItem
                                    key="custom"
                                    value={inputValue}
                                    onSelect={() => {
                                        form.setValue("symbol", inputValue.toUpperCase());
                                        setOpen(false);
                                    }}
                                >
                                    <Check className={cn("mr-2 h-4 w-4 opacity-0")} />
                                    Create "{inputValue.toUpperCase()}"
                                </CommandItem>
                            )}
                         </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="option_type"
            render={({ field }: any) => (
              <FormItem>
                <FormLabel>Type</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="CALL">CALL</SelectItem>
                    <SelectItem value="PUT">PUT</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="strike_price"
            render={({ field }: any) => (
              <FormItem>
                <FormLabel>Strike Price</FormLabel>
                <FormControl>
                  <Input type="number" step="0.01" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="expiration_date"
            render={({ field }: any) => (
              <FormItem className="flex flex-col">
                <FormLabel>Expiration</FormLabel>
                <Popover>
                  <PopoverTrigger asChild>
                    <FormControl>
                      <Button
                        variant={"outline"}
                        className={cn(
                          "w-full pl-3 text-left font-normal",
                          !field.value && "text-muted-foreground"
                        )}
                      >
                        {field.value ? (
                          format(field.value, "PPP")
                        ) : (
                          <span>Pick a date</span>
                        )}
                        <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                      </Button>
                    </FormControl>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={field.value}
                      onSelect={field.onChange}
                      disabled={(date: Date) =>
                        date < new Date(new Date().setHours(0, 0, 0, 0))
                      }
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <FormField
            control={form.control}
            name="entry_price"
            render={({ field }: any) => (
              <FormItem>
                <FormLabel>Entry Premium</FormLabel>
                <FormControl>
                  <Input type="number" step="0.01" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="quantity"
            render={({ field }: any) => (
              <FormItem>
                <FormLabel>Quantity</FormLabel>
                <FormControl>
                  <Input type="number" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="trailing_stop_loss_pct"
            render={({ field }: any) => (
              <FormItem>
                <FormLabel>Trailing Stop %</FormLabel>
                <FormControl>
                  <Input type="number" step="0.5" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <Button type="submit" className="w-full">
          {position ? 'Update Position' : 'Track Position'}
        </Button>
      </form>
    </Form>
  );
}
