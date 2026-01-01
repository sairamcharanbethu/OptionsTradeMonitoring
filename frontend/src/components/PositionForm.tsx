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
import { CalendarIcon, Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { api, Position } from '@/lib/api';
import { useToast } from "@/hooks/use-toast";

// Helper to debounce search
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = React.useState<T>(value);
  React.useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

const formSchema = z.object({
  symbol: z.string().min(1, 'Symbol is required').toUpperCase(),
  option_type: z.enum(['CALL', 'PUT']),
  strike_price: z.coerce.number().positive('Strike price must be positive'),
  expiration_date: z.date().refine(
    (date) => date >= new Date(new Date().setHours(0, 0, 0, 0)),
    'Expiration date must be in the future'
  ),
  entry_price: z.coerce.number().positive('Entry price must be positive'),
  quantity: z.coerce.number().int().positive('Quantity must be a positive integer'),
  trailing_stop_loss_pct: z.coerce.number().positive('Trailing stop loss must be positive').default(10),
  take_profit_trigger: z.coerce.number().positive('Take profit must be positive').optional().or(z.literal('')),
});

type FormValues = z.infer<typeof formSchema>;

export default function PositionForm({ onSuccess, position }: { onSuccess: () => void, position?: Position }) {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = React.useState(false);

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
      take_profit_trigger: position.take_profit_trigger,
    } : {
      symbol: '',
      option_type: 'CALL' as const,
      quantity: 1,
      trailing_stop_loss_pct: 10,
      take_profit_trigger: '' as any,
    },
  });

  const [open, setOpen] = React.useState(false);
  const [inputValue, setInputValue] = React.useState("");
  const [searchResults, setSearchResults] = React.useState<{ symbol: string, name: string }[]>([]);
  const [loadingSearch, setLoadingSearch] = React.useState(false);

  const debouncedSearchTerm = useDebounce(inputValue, 500);

  React.useEffect(() => {
    if (debouncedSearchTerm) {
      setLoadingSearch(true);
      api.searchSymbols(debouncedSearchTerm)
        .then(setSearchResults)
        .catch((err) => {
          console.error('Search error:', err);
          setSearchResults([]);
        })
        .finally(() => setLoadingSearch(false));
    } else {
      setSearchResults([]);
    }
  }, [debouncedSearchTerm]);

  const handleSelect = (val: string) => {
    form.setValue("symbol", val.toUpperCase());
    setOpen(false);
    setInputValue("");
  };

  const onSubmit: SubmitHandler<FormValues> = async (values) => {
    setIsSubmitting(true);

    const payload = {
      ...values,
      expiration_date: format(values.expiration_date, "yyyy-MM-dd"),
      take_profit_trigger: values.take_profit_trigger || undefined,
    };

    try {
      if (position) {
        await api.updatePosition(position.id, payload);
        toast({
          title: "Success",
          description: "Position updated successfully",
        });
      } else {
        await api.createPosition(payload);
        toast({
          title: "Success",
          description: "Position created successfully",
        });
      }
      form.reset();
      onSuccess();
    } catch (err: any) {
      console.error('Submission error:', err);
      toast({
        title: "Error",
        description: err?.message || "Failed to save position. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
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
              <FormItem className="space-y-1.5">
                <FormLabel className="whitespace-nowrap">Symbol</FormLabel>
                <Popover open={open} onOpenChange={setOpen}>
                  <PopoverTrigger asChild>
                    <FormControl>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={open}
                        type="button"
                        className={cn(
                          "w-full justify-between h-10 px-3 py-2",
                          !field.value && "text-muted-foreground"
                        )}
                      >
                        {field.value
                          ? field.value
                          : "Search ticker..."}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </FormControl>
                  </PopoverTrigger>
                  <PopoverContent className="w-[300px] p-0" align="start">
                    <div className="flex items-center border-b px-3">
                      <input
                        type="text"
                        placeholder="Type symbol or name..."
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        className="flex h-11 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
                        autoFocus
                      />
                    </div>
                    <div className="max-h-[300px] overflow-y-auto overflow-x-hidden p-1">
                      {loadingSearch && (
                        <div className="p-4 text-sm text-muted-foreground text-center flex items-center justify-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Searching...
                        </div>
                      )}
                      {!loadingSearch && searchResults.length === 0 && debouncedSearchTerm && (
                        <div className="py-6 text-center text-sm">No results found.</div>
                      )}
                      {searchResults.map((stock) => (
                        <button
                          key={stock.symbol}
                          type="button"
                          onClick={() => handleSelect(stock.symbol)}
                          className="relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              stock.symbol === field.value ? "opacity-100" : "opacity-0"
                            )}
                          />
                          <div className="flex flex-col text-left">
                            <span className="font-bold">{stock.symbol}</span>
                            <span className="text-xs text-muted-foreground truncate">{stock.name}</span>
                          </div>
                        </button>
                      ))}
                      {debouncedSearchTerm && !searchResults.some(s => s.symbol.toUpperCase() === debouncedSearchTerm.toUpperCase()) && (
                        <button
                          type="button"
                          onClick={() => handleSelect(debouncedSearchTerm)}
                          className="relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
                        >
                          <Check className="mr-2 h-4 w-4 opacity-0" />
                          Use custom: "{debouncedSearchTerm.toUpperCase()}"
                        </button>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="option_type"
            render={({ field }) => (
              <FormItem className="space-y-1.5">
                <FormLabel className="whitespace-nowrap">Option Type</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger className="h-10">
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
            render={({ field }) => (
              <FormItem className="space-y-1.5">
                <FormLabel className="whitespace-nowrap">Strike Price</FormLabel>
                <FormControl>
                  <Input type="number" step="0.01" className="h-10" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="expiration_date"
            render={({ field }) => (
              <FormItem className="flex flex-col space-y-1.5">
                <FormLabel className="whitespace-nowrap">Expiration Date</FormLabel>
                <Popover>
                  <PopoverTrigger asChild>
                    <FormControl>
                      <Button
                        variant={"outline"}
                        type="button"
                        className={cn(
                          "w-full pl-3 text-left font-normal h-10",
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

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <FormField
            control={form.control}
            name="entry_price"
            render={({ field }) => (
              <FormItem className="space-y-1.5">
                <FormLabel className="whitespace-nowrap">Entry Price</FormLabel>
                <FormControl>
                  <Input type="number" step="0.01" className="h-10" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="quantity"
            render={({ field }) => (
              <FormItem className="space-y-1.5">
                <FormLabel className="whitespace-nowrap">Quantity</FormLabel>
                <FormControl>
                  <Input type="number" className="h-10" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="trailing_stop_loss_pct"
            render={({ field }) => (
              <FormItem className="space-y-1.5">
                <FormLabel className="whitespace-nowrap">Trailing SL %</FormLabel>
                <FormControl>
                  <Input type="number" step="0.5" className="h-10" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="take_profit_trigger"
            render={({ field }) => (
              <FormItem className="space-y-1.5">
                <FormLabel className="whitespace-nowrap">Take Profit</FormLabel>
                <FormControl>
                  <Input type="number" step="0.01" placeholder="Optional" className="h-10" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {position ? 'Updating...' : 'Creating...'}
            </>
          ) : (
            position ? 'Update Position' : 'Track Position'
          )}
        </Button>
      </form>
    </Form>
  );
}