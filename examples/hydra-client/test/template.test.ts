import { describe, expect, it } from 'vitest'

import { expandTemplate, isQueryOnlyTemplate, templateVariables } from '../src/execute/template'

/**
 * RFC 6570 expansion (task 5.1).
 *
 * The vectors below are the specification's own. They are here rather than a handful of cases this
 * API happens to publish because the client consumes whatever template a server declares, and the
 * proof of concept's single-operator implementation plus a regex that deleted unbound path segments
 * (`index.html:484`) produced URLs the specification does not define.
 */

const VARS = {
  var: 'value',
  hello: 'Hello World!',
  path: '/foo/bar',
  list: ['red', 'green', 'blue'],
  x: 1024,
  y: 768,
  empty: '',
}

describe('URI template expansion', () => {
  it.each([
    ['{var}', 'value'],
    ['{var:3}', 'val'],
    ['O{empty}X', 'OX'],
    ['{undefined}', ''],
    ['{x,y}', '1024,768'],
    ['{+path}/here', '/foo/bar/here'],
    ['{+var}', 'value'],
    ['X{#var}', 'X#value'],
    ['X{.var}', 'X.value'],
    ['{/var}', '/value'],
    ['{;x,y}', ';x=1024;y=768'],
    ['{?x,y}', '?x=1024&y=768'],
    ['{?x,y,empty}', '?x=1024&y=768&empty='],
    ['{?undefined}', ''],
    ['?fixed=yes{&x}', '?fixed=yes&x=1024'],
    ['{/list}', '/red,green,blue'],
    ['{/list*}', '/red/green/blue'],
    ['{?list}', '?list=red,green,blue'],
    ['{?list*}', '?list=red&list=green&list=blue'],
  ])('expands %s to %s', (template, expected) => {
    expect(expandTemplate(template, VARS).url).toBe(expected)
  })

  it('percent-encodes what the specification calls reserved, which encodeURIComponent does not', () => {
    // `!` is reserved. `encodeURIComponent` leaves it alone, so borrowing it would produce a URL that
    // differs from what the template means.
    expect(expandTemplate('{hello}', VARS).url).toBe('Hello%20World%21')
    // Under the reserved operator it passes through, which is the whole point of that operator.
    expect(expandTemplate('{+hello}', VARS).url).toBe('Hello%20World!')
  })

  it('reports variables that were declared and left unbound', () => {
    const expansion = expandTemplate('{?q,firstName,lastName}', { q: 'jane' })
    expect(expansion.url).toBe('?q=jane')
    expect(expansion.variables).toEqual(['q', 'firstName', 'lastName'])
    expect(expansion.unbound).toEqual(['firstName', 'lastName'])
  })

  it('reports a supplied value the template cannot carry, rather than dropping it', () => {
    /*
     * Design D8's rule, at the smallest possible scale. A caller that asked to filter on a variable
     * the template does not declare must not be handed a result that looks filtered.
     */
    const expansion = expandTemplate('{?q}', { q: 'jane', jobTitle: 'Engineer' })
    expect(expansion.unused).toEqual(['jobTitle'])
  })

  it('lists a template’s variables without expanding it', () => {
    expect(templateVariables('/Api/Event/Status/{status}/Page/{page}')).toEqual(['status', 'page'])
  })

  describe('a form-style template states the IRI of the thing it searches', () => {
    /**
     * This is what lets a collection be located without constructing a URL (task 5.1). Expanding with
     * nothing bound is defined to yield the literal prefix, so the template is a *statement* of the
     * unconstrained resource's address rather than a pattern to be taken apart.
     */
    it('recognises a query-only template and expands it to its prefix', () => {
      const template = 'https://lending.example/api/stacks{?anything,heading,isbn}'
      expect(isQueryOnlyTemplate(template)).toBe(true)
      expect(expandTemplate(template, {}).url).toBe('https://lending.example/api/stacks')
    })

    it('does not treat a path template that way, because its prefix identifies nothing', () => {
      // `…/Page/{page}` with nothing bound is `…/Page/`, which is not the collection.
      expect(isQueryOnlyTemplate('https://lending.example/api/stacks/leaf/{leaf}')).toBe(false)
      expect(isQueryOnlyTemplate('https://lending.example/api/stacks/leaf/{leaf}{?q}')).toBe(false)
    })
  })
})
