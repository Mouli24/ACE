import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';

import { Checkbox } from '../components/checkbox.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../components/dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/dropdown-menu.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/select.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/tabs.js';
import { Textarea } from '../components/textarea.js';
import { Toaster, toast } from '../components/toaster.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/tooltip.js';

describe('shadcn overlays and controls render and respond', () => {
  it('Dialog opens from its trigger and shows title, description, footer', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>open</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Title</DialogTitle>
            <DialogDescription>Desc</DialogDescription>
          </DialogHeader>
          <DialogFooter>footer</DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    await user.click(screen.getByText('open'));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Title');
    expect(screen.getByText('Desc')).toBeInTheDocument();
    expect(screen.getByText('footer')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('DropdownMenu opens and fires onSelect', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onSelect}>One</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem>Two</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByText('menu'));
    await user.click(await screen.findByRole('menuitem', { name: 'One' }));
    expect(onSelect).toHaveBeenCalled();
  });

  it('Select changes its value', async () => {
    const user = userEvent.setup();
    function Demo() {
      const [value, setValue] = useState('a');
      return (
        <Select value={value} onValueChange={setValue}>
          <SelectTrigger aria-label="pick">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">Alpha</SelectItem>
            <SelectItem value="b">Beta</SelectItem>
          </SelectContent>
        </Select>
      );
    }
    render(<Demo />);
    await user.click(screen.getByLabelText('pick'));
    await user.click(await screen.findByRole('option', { name: 'Beta' }));
    expect(screen.getByLabelText('pick')).toHaveTextContent('Beta');
  });

  it('Tabs switch content', async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="x">
        <TabsList>
          <TabsTrigger value="x">X</TabsTrigger>
          <TabsTrigger value="y">Y</TabsTrigger>
        </TabsList>
        <TabsContent value="x">content x</TabsContent>
        <TabsContent value="y">content y</TabsContent>
      </Tabs>,
    );
    expect(screen.getByText('content x')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Y' }));
    expect(await screen.findByText('content y')).toBeInTheDocument();
  });

  it('Tooltip shows on hover', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger>hover me</TooltipTrigger>
          <TooltipContent>tip</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    await user.hover(screen.getByText('hover me'));
    expect((await screen.findAllByText('tip')).length).toBeGreaterThan(0);
  });

  it('Checkbox toggles and Textarea edits', async () => {
    const user = userEvent.setup();
    const onChecked = vi.fn();
    render(
      <>
        <Checkbox aria-label="box" onCheckedChange={onChecked} />
        <Textarea aria-label="area" defaultValue="a" />
      </>,
    );
    await user.click(screen.getByLabelText('box'));
    expect(onChecked).toHaveBeenCalledWith(true);
    await user.type(screen.getByLabelText('area'), 'b');
    expect(screen.getByLabelText('area')).toHaveValue('ab');
  });

  it('Toaster renders toasts', async () => {
    render(<Toaster />);
    toast.error('Refused', { description: 'why' });
    expect(await screen.findByText('Refused')).toBeInTheDocument();
    expect(screen.getByText('why')).toBeInTheDocument();
  });
});
