import { render, screen } from '@testing-library/react';

import { Badge } from '../components/badge.js';
import { Button } from '../components/button.js';
import { Input } from '../components/input.js';
import { Label } from '../components/label.js';
import { Tabs, TabsList, TabsTrigger } from '../components/tabs.js';
import { cn } from '../lib/cn.js';
import type { NodeCardProps, PortHandleProps } from '../types.js';

describe('cn', () => {
  it('merges tailwind classes, later wins', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    const off: boolean = 'x'.length > 5;
    expect(cn('a', off && 'b', undefined, 'c')).toBe('a c');
  });
});

describe('shadcn base components', () => {
  it('Button renders a real <button> with the variant classes and forwards props', () => {
    render(
      <Button variant="destructive" size="sm" data-testid="btn">
        Delete
      </Button>,
    );
    const btn = screen.getByTestId('btn');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveTextContent('Delete');
    expect(btn.className).toContain('bg-danger');
  });

  it('Button asChild renders the child element instead', () => {
    render(
      <Button asChild>
        <a href="/x">Link</a>
      </Button>,
    );
    expect(screen.getByRole('link', { name: 'Link' })).toBeInTheDocument();
  });

  it('Input and Label associate through htmlFor', () => {
    render(
      <>
        <Label htmlFor="name">Name</Label>
        <Input id="name" defaultValue="Agent" />
      </>,
    );
    expect(screen.getByLabelText('Name')).toHaveValue('Agent');
  });

  it('Badge renders inline text', () => {
    render(<Badge>no model</Badge>);
    expect(screen.getByText('no model')).toBeInTheDocument();
  });
});

describe('restyled primitives keep their roles and names', () => {
  it('Button resolves by role and name', () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' })).toBeInTheDocument();
  });

  it('TabsTrigger resolves as a tab inside the pill TabsList', () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    expect(screen.getByRole('tablist')).toContainElement(screen.getByRole('tab', { name: 'A' }));
  });

  it('Badge and Input still render their content', () => {
    render(
      <>
        <Badge>tag</Badge>
        <Input aria-label="Name" />
      </>,
    );
    expect(screen.getByText('tag')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
  });
});

describe('shared prop types', () => {
  it('NodeCardProps and PortHandleProps describe the card contract', () => {
    const port: PortHandleProps = {
      port: {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV:in:text',
        name: 'text',
        dataType: 'text',
        multi: false,
      },
      direction: 'in',
      connected: false,
    };
    const card: NodeCardProps = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      kind: 'agent',
      name: 'Writer',
      state: 'IDLE',
      provider: undefined,
      modelLabel: 'no model',
      inputs: [port.port],
      outputs: [],
      selected: false,
    };
    expect(card.state).toBe('IDLE');
    expect(port.direction).toBe('in');
  });
});
